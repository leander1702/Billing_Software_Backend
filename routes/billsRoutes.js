// routes/bills.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Bill = require('../models/Bill');
const StockQuantity = require('../models/StockQuantity');
const AdminProduct = require('../models/AdminProduct');
const Customer = require('../models/Customer');

router.get('/', async (req, res) => {
    try {
        const { customerId, unpaidOnly } = req.query;

        // Validate customerId if provided
        if (customerId && isNaN(parseInt(customerId))) {
            return res.status(400).json({ message: 'Customer ID must be a number' });
        }

        // If customerId is provided with unpaidOnly=true
        if (customerId && unpaidOnly === 'true') {
            const unpaidBills = await Bill.find({
                'customer.id': parseInt(customerId),
                unpaidAmountForThisBill: { $gt: 0 }
            }).sort({ createdAt: 1 }).lean();

            // Ensure all bills have required fields
            const validatedBills = unpaidBills.map(bill => ({
                ...bill,
                customer: {
                    id: bill.customer?.id || 0,
                    name: bill.customer?.name || 'Unknown',
                    contact: bill.customer?.contact || 'Not provided'
                },
                products: bill.products?.map(p => ({
                    name: p.name || 'Unnamed product',
                    price: p.price || 0,
                    quantity: p.quantity || 0
                })) || [],
                total: bill.total || 0,
                unpaidAmountForThisBill: bill.unpaidAmountForThisBill || 0
            }));

            return res.status(200).json(validatedBills);
        }

        // If no specific query parameters, return all bills
        const bills = await Bill.find().lean();
        res.status(200).json(bills);
    } catch (err) {
        console.error('Error fetching bills:', err);
        res.status(500).json({ message: 'Failed to fetch bills', error: err.message });
    }
});

// Keep the separate unpaid endpoint for backward compatibility
router.get('/unpaid', async (req, res) => {
    try {
        const { customerId } = req.query;
        if (!customerId) {
            return res.status(400).json({ message: 'Customer ID is required' });
        }

        // Find bills for the customer where 'unpaidAmountForThisBill' is greater than 0
        const unpaidBills = await Bill.find({
            'customer.id': parseInt(customerId),
            unpaidAmountForThisBill: { $gt: 0 }
        }).sort({ createdAt: 1 });

        res.status(200).json(unpaidBills);
    } catch (err) {
        console.error('Error fetching unpaid bills:', err);
        res.status(500).json({ message: 'Failed to fetch unpaid bills' });
    }
});


router.post('/settle-outstanding', async (req, res) => {
    try {
        const {
            customerId, // Needed to update customer's total outstanding credit
            paymentMethod,
            transactionId,
            amountPaid,
            cashier, // Total amount paid for outstanding bills in this transaction
            selectedUnpaidBillIds // Array of bill _ids to be updated
        } = req.body;

        if (!cashier || !cashier.cashierId || !cashier.cashierName || !cashier.counterNum) {
            return res.status(400).json({ message: 'Cashier details are required.' });
        }
        // Validate required input fields
        if (!customerId || !paymentMethod || typeof amountPaid === 'undefined' || !Array.isArray(selectedUnpaidBillIds) || selectedUnpaidBillIds.length === 0) {
            return res.status(400).json({ message: 'Missing required payment details or selected bills.' });
        }

        let remainingPaymentToDistribute = amountPaid; // Amount left to apply to bills
        const updatedBills = []; // To store the bills that were successfully updated

        // Fetch selected bills that are still outstanding, sorted by date to prioritize older debts
        const billsToUpdate = await Bill.find({
            _id: { $in: selectedUnpaidBillIds },
            unpaidAmountForThisBill: { $gt: 0 } // Ensure they are genuinely unpaid
        }).sort({ date: 1 });

        if (billsToUpdate.length === 0) {
            return res.status(404).json({ message: 'No valid outstanding bills found for settlement.' });
        }

        // Iterate through the selected bills and apply the payment
        for (const bill of billsToUpdate) {
            if (remainingPaymentToDistribute <= 0) break; // Stop if no more payment to distribute

            const unpaidAmount = bill.unpaidAmountForThisBill; // Current unpaid amount for THIS specific bill

            bill.cashier = {
                cashierId: cashier.cashierId,
                cashierName: cashier.cashierName,
                counterNum: cashier.counterNum,
                contactNumber: cashier.contactNumber
            };
            
            if (remainingPaymentToDistribute >= unpaidAmount) {
                // If the remaining payment covers this bill's unpaid amount, fully pay it off
                bill.paidAmount += unpaidAmount; // Add the full unpaid amount to the bill's paid total
                bill.unpaidAmountForThisBill = 0; // Set unpaid amount for THIS bill to zero
                bill.status = 'paid'; // Mark THIS bill as fully paid
                remainingPaymentToDistribute -= unpaidAmount; // Reduce the payment amount remaining
            } else {
                // If the remaining payment is less than this bill's unpaid amount, partially pay it
                bill.paidAmount += remainingPaymentToDistribute; // Add the remaining payment to the bill's paid total
                bill.unpaidAmountForThisBill -= remainingPaymentToDistribute; // Reduce unpaid amount for THIS bill
                bill.status = 'partial'; // Mark THIS bill as partially paid
                remainingPaymentToDistribute = 0; // All payment distributed
            }

            bill.paymentMethod = paymentMethod; // Update payment method for this specific payment
            if (transactionId) {
                bill.transactionId = transactionId; // Update transaction ID
            }
            updatedBills.push(await bill.save()); // Save the updated bill document
        }

        // Update customer's total outstanding credit after these payments
        const customerRecord = await Customer.findOne({ id: customerId });
        if (customerRecord) {
            // Recalculate customer's total outstanding by summing 'unpaidAmountForThisBill'
            // across all their bills that still have an outstanding balance.
            const remainingOutstanding = await Bill.aggregate([
                { $match: { 'customer.id': parseInt(customerId), unpaidAmountForThisBill: { $gt: 0 } } },
                { $group: { _id: null, totalUnpaid: { $sum: '$unpaidAmountForThisBill' } } }
            ]);

            customerRecord.outstandingCredit = remainingOutstanding.length > 0 ? remainingOutstanding[0].totalUnpaid : 0;
            await customerRecord.save(); // Save the updated customer record
        }

        res.status(200).json({
            message: 'Outstanding bills settled successfully.',
            updatedBills: updatedBills,
            remainingPayment: remainingPaymentToDistribute // Any change if amountPaid was more than selected bills
        });

    } catch (error) {
        console.error('Error settling outstanding bills:', error);
        res.status(500).json({ message: 'Failed to settle outstanding bills.', error: error.message });
    }
});

router.post('/', async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    
    try {
        const billData = req.body;
        const {
            customer,
            products,
            productSubtotal,
            productGst,
            // currentBillTotal, // This field is now redundant as grandTotal is derived
            previousOutstandingCredit, // This is just for informational purposes or customer display
            payment,
            cashier,
            billNumber,
            selectedUnpaidBillIds = []
        } = billData;

        // Calculate the grandTotal for the CURRENT new bill based ONLY on its products and GST.
        // This ensures 'grandTotal' strictly represents the value of the current purchase.
        const grandTotalForCurrentBill = (productSubtotal || 0) + (productGst || 0);
        if (!cashier || !cashier.cashierId || !cashier.cashierName || !cashier.counterNum) {
            return res.status(400).json({ message: 'Cashier details are required.' });
        }

        if (!customer || typeof customer.id === 'undefined' || !payment || typeof payment.amountPaid === 'undefined') {
            return res.status(400).json({ message: 'Required fields missing for new bill creation.' });
        console.log("Received bill data:", JSON.stringify(billData, null, 2));

        // Validate required fields
        if (!billData.customer || !billData.customer.id) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ 
                success: false,
                message: 'Customer information is required' 
            });
        }

        // Check if this is an outstanding-only payment
        const isOutstandingOnly = (!billData.products || billData.products.length === 0) && 
                                (billData.payment?.selectedOutstandingPayment > 0);

        if (!isOutstandingOnly && (!billData.products || billData.products.length === 0)) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ 
                success: false,
                message: 'At least one product is required for regular bills' 
            });
        }

        // Calculate totals including transport charge
        const transportCharge = parseFloat(billData.transportCharge) || 0;
        let productSubtotal = 0;
        let totalTax = 0;
        let currentBillTotal = 0;

        if (!isOutstandingOnly) {
            productSubtotal = billData.products.reduce((sum, item) => {
                return sum + (item.basicPrice * item.quantity);
            }, 0);
            
            totalTax = billData.products.reduce((sum, item) => {
                return sum + ((item.gstAmount + item.sgstAmount) * item.quantity);
            }, 0);
            
            currentBillTotal = productSubtotal + totalTax;
        }

        const grandTotal = currentBillTotal + transportCharge + (billData.payment?.selectedOutstandingPayment || 0);

        // Validate payment
        if (!billData.payment || (typeof billData.payment.currentBillPayment === 'undefined' && 
                                 typeof billData.payment.selectedOutstandingPayment === 'undefined')) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ 
                success: false,
                message: 'Payment information is required' 
            });
        }

        const paymentAmount = (parseFloat(billData.payment.currentBillPayment) || 0) + 
                            (parseFloat(billData.payment.selectedOutstandingPayment) || 0);
        
        const unpaidAmount = Math.max(0, grandTotal - paymentAmount);
        
        const status = unpaidAmount > 0 
            ? (paymentAmount > 0 ? 'partial' : 'unpaid') 
            : 'paid';

        // Create the bill document (only if not outstanding-only)
        let savedBill = null;
        if (!isOutstandingOnly) {
            const newBill = new Bill({
                customer: billData.customer,
                products: billData.products.map(p => ({
                    name: p.name,
                    code: p.code,
                    price: p.price,
                    quantity: p.quantity,
                    unit: p.unit,
                    totalPrice: p.totalPrice,
                    discount: p.discount || 0,
                    basicPrice: p.basicPrice || 0,
                    gst: p.gst || 0,
                    sgst: p.sgst || 0,
                    gstAmount: p.gstAmount || 0,
                    sgstAmount: p.sgstAmount || 0,
                    hsnCode: p.hsnCode || ''
                })),
                productSubtotal: productSubtotal,
                taxAmount: totalTax,
                transportCharge: transportCharge,
                currentBillTotal: currentBillTotal,
                grandTotal: grandTotal,
                paidAmount: paymentAmount,
                unpaidAmountForThisBill: unpaidAmount,
                status: status,
                billNumber: billData.billNumber || `BILL-${Date.now()}`,
                paymentMethod: billData.payment.method || 'cash',
                transactionId: billData.payment.transactionId || '',
                paymentDetails: {
                    currentBillPayment: billData.payment.currentBillPayment || 0,
                    outstandingPayment: billData.payment.selectedOutstandingPayment || 0
                }
            });

            savedBill = await newBill.save({ session });

            // Update stock quantities (only for regular bills)
            for (const item of billData.products) {
                const product = await AdminProduct.findOne({ 
                    $or: [
                        { productName: item.name },
                        { productCode: item.code }
                    ]
                }).session(session);
                
                if (!product) {
                    console.warn(`Product not found: ${item.name} (${item.code})`);
                    continue;
                }
            }
        }

        // --- Process current new bill payment ---
        // 'payment.currentBillPayment' is the amount specifically paid towards THIS new bill.
        let newBillCalculatedUnpaid = grandTotalForCurrentBill - payment.currentBillPayment;
        if (newBillCalculatedUnpaid < 0) newBillCalculatedUnpaid = 0;

        let newBillStatus = newBillCalculatedUnpaid > 0 ? (payment.currentBillPayment > 0 ? 'partial' : 'unpaid') : 'paid';

        const newBill = new Bill({
            customer: {
                id: customer.id,
                name: customer.name,
                contact: customer.contact,
                aadhaar: customer.aadhaar,
                location: customer.location
            },
            cashier: {
                cashierId: cashier.cashierId,
                cashierName: cashier.cashierName,
                counterNum: cashier.counterNum,
                contactNumber: cashier.contactNumber
            },
            products,
            productSubtotal,
            productGst,
            currentBillTotal: grandTotalForCurrentBill, // Use the calculated grandTotal for currentBillTotal
            previousOutstandingCredit, // This remains as informational, not part of current bill's grandTotal
            grandTotal: grandTotalForCurrentBill, // Store the calculated grandTotal for THIS bill
            paidAmount: payment.currentBillPayment,
            unpaidAmountForThisBill: newBillCalculatedUnpaid,
            status: newBillStatus,
            billNumber,
            paymentMethod: payment.method,
            transactionId: payment.transactionId
        });

        await newBill.save();

                const stock = await StockQuantity.findOne({ productCode: product.productCode }).session(session);
                if (!stock) {
                    console.warn(`Stock not found for product: ${product.productCode}`);
                    continue;
                }

                const conversionRate = product.conversionRate || 1;
                const qtyInBase = item.unit === product.baseUnit
                    ? item.quantity
                    : item.quantity / conversionRate;

                stock.availableQuantity -= qtyInBase;
                await stock.save({ session });
            }
        }

        // Handle outstanding payments if any
        if (billData.selectedUnpaidBillIds?.length > 0 && billData.payment.selectedOutstandingPayment > 0) {
            await settleOutstandingBills(
                billData.customer.id,
                billData.payment.method,
                billData.payment.transactionId,
                billData.payment.selectedOutstandingPayment,
                billData.selectedUnpaidBillIds,
                session
            );
        }

        // Update customer outstanding credit
        const customerRecord = await Customer.findOne({ id: billData.customer.id }).session(session);
        if (customerRecord) {
            const result = await Bill.aggregate([
                { $match: { 'customer.id': parseInt(billData.customer.id), unpaidAmountForThisBill: { $gt: 0 } } },
                { $group: { _id: null, totalUnpaid: { $sum: '$unpaidAmountForThisBill' } } }
            ]).session(session);
            
            customerRecord.outstandingCredit = result[0]?.totalUnpaid || 0;
            await customerRecord.save({ session });
        }

        await session.commitTransaction();
        session.endSession();

        res.status(201).json({
            success: true,
            message: isOutstandingOnly ? 'Outstanding payments processed successfully' : 'Bill created successfully',
            bill: savedBill
        });

    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error('Error creating bill:', error);
        
        if (error.code === 11000 && error.keyPattern?.billNumber) {
            return res.status(409).json({ 
                success: false,
                message: 'Bill number already exists' 
            });
        }
        
        res.status(500).json({ 
            success: false,
            message: 'Failed to process payment',
            error: error.message
        });
    }
});

async function settleOutstandingBills(customerId, paymentMethod, transactionId, amount, billIds, session) {
    let remainingAmount = amount;
    const bills = await Bill.find({
        _id: { $in: billIds },
        unpaidAmountForThisBill: { $gt: 0 }
    }).session(session).sort({ date: 1 });

    for (const bill of bills) {
        if (remainingAmount <= 0) break;
        
        const paymentApplied = Math.min(remainingAmount, bill.unpaidAmountForThisBill);
        bill.paidAmount += paymentApplied;
        bill.unpaidAmountForThisBill -= paymentApplied;
        bill.status = bill.unpaidAmountForThisBill > 0 ? 'partial' : 'paid';
        bill.paymentMethod = paymentMethod;
        if (transactionId) bill.transactionId = transactionId;
        
        await bill.save({ session });
        remainingAmount -= paymentApplied;
    }
}

module.exports = router;
