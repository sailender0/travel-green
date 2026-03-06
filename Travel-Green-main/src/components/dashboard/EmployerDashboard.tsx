'use client';

import React, { useState, useEffect, useRef } from 'react';
import { collection, query, where, getDocs, orderBy, doc, getDoc, updateDoc, setDoc, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { styles, colors, createScrollStyles } from './dashboardStyles';
import { Organization, Employee, Toast as ToastType, TripData, PendingEmployee, CreditTransaction } from './dashboardTypes';
import { useAuth } from '@/contexts/AuthContext';
import Toast from './Toast';
import Header from './Header';
import scrollbarStyles from './scrollbar.module.css';
import { XCircleIcon, CheckCircleIcon } from '@heroicons/react/24/solid';

const EmployerDashboard: React.FC = () => {
  const [currentOrganization, setCurrentOrganization] = useState<Organization | null>(null);
  const [employees, setEmployees] = useState<(Employee & { calculatedCredits?: number })[]>([]);
  const [allEmployees, setAllEmployees] = useState<Employee[]>([]);
  const [pendingEmployees, setPendingEmployees] = useState<PendingEmployee[]>([]);
  const [trips, setTrips] = useState<TripData[]>([]);
  const [totalOrgCredits, setTotalOrgCredits] = useState<number>(0);
  const [employeeEarnedCredits, setEmployeeEarnedCredits] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [isProcessingApproval, setIsProcessingApproval] = useState<boolean>(false);
  const [toast, setToast] = useState<ToastType>({ visible: false, message: '', type: 'info' });
  const [showTransactionModal, setShowTransactionModal] = useState<boolean>(false);
  const [transactionType, setTransactionType] = useState<'buy' | 'sell'>('buy');
  const [selectedOrgId, setSelectedOrgId] = useState<string>('');
  const [creditAmount, setCreditAmount] = useState<string>('');
  const [creditPrice, setCreditPrice] = useState<string>('');
  const [isSearchFocused, setIsSearchFocused] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(null);
  const [showCreditHistoryModal, setShowCreditHistoryModal] = useState<boolean>(false);
  const [availableSales, setAvailableSales] = useState<CreditTransaction[]>([]);
  const [isLoadingSales, setIsLoadingSales] = useState<boolean>(false);
  const [transactionError, setTransactionError] = useState<string>('');
  const [isProcessingTransaction, setIsProcessingTransaction] = useState<boolean>(false);
  const [employeeToDelete, setEmployeeToDelete] = useState<Employee | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [filteredEmps, setFilteredEmps] = useState<(Employee & { calculatedCredits?: number })[]>([]);
  const [transactions, setTransactions] = useState<CreditTransaction[]>([]);
  const [isLoadingTransactions, setIsLoadingTransactions] = useState<boolean>(false);
  
  // Add refs for all scrollable containers
  const transactionHistoryScrollRef = useRef<HTMLDivElement>(null);
  const employeeListScrollRef = useRef<HTMLDivElement>(null);
  const employeeTripsScrollRef = useRef<HTMLDivElement>(null);
  const pendingEmployeesScrollRef = useRef<HTMLDivElement>(null);
  const creditHistoryScrollRef = useRef<HTMLDivElement>(null);
  const availableSalesScrollRef = useRef<HTMLDivElement>(null);
  
  // Add a ref to track if initial transactions have been loaded
  const transactionsLoadedRef = useRef<boolean>(false);
  
  // Add a ref to track if available sales have been loaded
  const availableSalesLoadedRef = useRef<boolean>(false);
  
  // Add a ref to track if credits have been calculated
  const creditsCalculatedRef = useRef<boolean>(false);
  
  const { user, userData } = useAuth();

  useEffect(() => {
    if (userData?.domain) {
      fetchOrganizationByDomain(userData.domain);
      fetchPendingEmployees(userData.domain);
    }
  }, [userData]);

  // Fix infinite loop by adding a ref check
  useEffect(() => {
    if (currentOrganization?.id && !transactionsLoadedRef.current) {
      transactionsLoadedRef.current = true;
      fetchTransactionHistory(currentOrganization.id, false);
    }
  }, [currentOrganization]);

  useEffect(() => {
    if (employees.length > 0) {
      let filtered = employees;
      
      if (searchQuery.trim() !== '') {
        const lowercaseQuery = searchQuery.toLowerCase();
        filtered = employees.filter(
          emp => 
            emp.name.toLowerCase().includes(lowercaseQuery) || 
            emp.email.toLowerCase().includes(lowercaseQuery)
        );
      }
      
      // Sort employees by their calculated credits (highest first)
      filtered = [...filtered].sort((a, b) => {
        // Use calculatedCredits if available, otherwise use the base carbonCredits
        const creditsA = a.calculatedCredits !== undefined ? a.calculatedCredits : a.carbonCredits;
        const creditsB = b.calculatedCredits !== undefined ? b.calculatedCredits : b.carbonCredits;
        return creditsB - creditsA;
      });
      
      setFilteredEmps(filtered);
    }
  }, [employees, searchQuery]);

  // Update the useEffect for credit calculation to prevent unnecessary refreshes
  useEffect(() => {
    if (currentOrganization && employees.length > 0 && !creditsCalculatedRef.current) {
      // Get all employee IDs for credit calculation
      const employeeIds = employees.map(emp => emp.id);
      
      // Calculate total credits based on employee trips and transactions
      calculateTotalOrgCredits(currentOrganization.id, employeeIds);
      
      // Mark credits as calculated so we don't repeat unnecessarily
      creditsCalculatedRef.current = true;
    }
  }, [currentOrganization, employees]);

  // Fix infinite loop by adding a ref check for availableSales
  useEffect(() => {
    if (currentOrganization?.id && !availableSalesLoadedRef.current) {
      availableSalesLoadedRef.current = true;
      fetchAvailableSales();
    }
  }, [currentOrganization]);

  const fetchCurrentOrganization = async (orgId: string) => {
    try {
      setLoading(true);
      const orgDoc = await getDoc(doc(db, 'organizations', orgId));
      
      if (orgDoc.exists()) {
        const data = orgDoc.data();
        const organization: Organization = {
          id: orgDoc.id,
          name: data.name || 'Unknown Organization',
          domain: data.domain || '',
          address: data.address,
          totalCredits: data.totalCredits || 0,
          carbonCredits: data.carbonCredits || 0,
          availableMoney: data.availableMoney || 0,
          createdAt: data.createdAt || ''
        };
        
        setCurrentOrganization(organization);
        fetchOrganizationEmployees(organization.domain);
      }
    } catch (error) {
      console.error("Error fetching current organization:", error);
      showToast('Failed to load organization data', 'error');
    } finally {
      setLoading(false);
    }
  };

  const fetchOrganizationByDomain = async (domain: string) => {
    try {
      setLoading(true);
      
      // Query for organizations with matching domain
      const organizationsQuery = query(
        collection(db, 'organizations'),
        where('domain', '==', domain)
      );
      
      const organizationsSnapshot = await getDocs(organizationsQuery);
      
      if (!organizationsSnapshot.empty) {
        // Get the first matching organization
        const orgDoc = organizationsSnapshot.docs[0];
        const data = orgDoc.data();
        const organization: Organization = {
          id: orgDoc.id,
          name: data.name || 'Unknown Organization',
          domain: data.domain || domain,
          address: data.address,
          totalCredits: data.totalCredits || 0,
          carbonCredits: data.carbonCredits || 0,
          availableMoney: data.availableMoney || 0,
          createdAt: data.createdAt || ''
        };
        
        setCurrentOrganization(organization);
        await fetchOrganizationEmployees(domain);
      } else {
        console.error("No organization found for domain:", domain);
        showToast('No organization found for your domain', 'error');
      }
    } catch (error) {
      console.error("Error fetching organization by domain:", error);
      showToast('Failed to load organization data', 'error');
    } finally {
      setLoading(false);
    }
  };

  const fetchOrganizationEmployees = async (domain: string) => {
    try {
      const employeesQuery = query(
        collection(db, 'users'),
        where('domain', '==', domain),
        where('role', '==', 'employee'),
        where('approved', '==', true)
      );
      
      const employeesSnapshot = await getDocs(employeesQuery);
      const employeesList: Employee[] = [];
      const employeeIds: string[] = [];
      
      employeesSnapshot.forEach(doc => {
        const data = doc.data();
        employeesList.push({
          id: doc.id,
          name: data.name || 'Unknown Employee',
          email: data.email || '',
          domain: data.domain || domain,
          carbonCredits: data.carbonCredits || 0,
          role: data.role || 'employee',
          approved: data.approved || false,
          status: data.status || 'active',
          active: data.active !== false
        });
        
        employeeIds.push(doc.id);
      });
      
      setEmployees(employeesList);
      setAllEmployees(employeesList);
      
      // Fetch trips for these employees
      await fetchEmployeeTrips(employeeIds);
      
      // Calculate total credits for the organization if there are employees
      if (employeeIds.length > 0 && currentOrganization) {
        await calculateTotalOrgCredits(currentOrganization.id, employeeIds);
      }
    } catch (error) {
      console.error("Error fetching organization employees:", error);
      showToast('Failed to load employee data', 'error');
    }
  };

  // Optimize fetchEmployeeTrips to prevent unnecessary updates when data hasn't changed
  const fetchEmployeeTrips = async (employeeIds: string[]) => {
    try {
      if (employeeIds.length === 0) {
        setTrips([]);
        return;
      }
      
      // For each batch of 10 employee IDs (Firebase limit for 'in' queries)
      const batchSize = 10;
      const tripsList: TripData[] = [];
      const employeeCreditMap: Record<string, number> = {};
      
      // Initialize credits for each employee to 0
      employeeIds.forEach(id => {
        employeeCreditMap[id] = 0;
      });
      
      let hasNewTrips = false;
      
      // Process employee IDs in batches
      for (let i = 0; i < employeeIds.length; i += batchSize) {
        const batch = employeeIds.slice(i, i + batchSize);
        
        // Query trips for this batch of employees
        const tripsQuery = query(
          collection(db, 'trips'),
          where('userId', 'in', batch),
          orderBy('tripDate', 'desc') // Order by date to get most recent trips first
        );
        
        const tripsSnapshot = await getDocs(tripsQuery);
        
        tripsSnapshot.forEach(doc => {
          const data = doc.data();
          const trip: TripData = {
            id: doc.id,
            userId: data.userId || '',
            startLocation: data.startLocation || { latitude: 0, longitude: 0 },
            endLocation: data.endLocation || { latitude: 0, longitude: 0 },
            startAddress: data.startAddress,
            endAddress: data.endAddress,
            startTime: data.startTime?.toDate() || new Date(),
            endTime: data.endTime?.toDate() || new Date(),
            tripDate: data.tripDate?.toDate() || new Date(),
            distanceKm: data.distanceKm || 0,
            avgSpeedKmh: data.avgSpeedKmh || 0,
            transportMode: data.transportMode || 'unknown',
            carbonCredits: data.carbonCredits || 0,
            isWorkFromHome: data.isWorkFromHome || false,
            rejected: data.rejected || false
          };
          
          tripsList.push(trip);
          
          // Track if we found a trip that wasn't in our previous list
          if (!trips.some(existingTrip => existingTrip.id === trip.id)) {
            hasNewTrips = true;
          }
          
          // Update employee credit map for non-rejected trips
          if (!trip.rejected && trip.userId) {
            employeeCreditMap[trip.userId] = (employeeCreditMap[trip.userId] || 0) + trip.carbonCredits;
          }
        });
      }
      
      // Only update if we have new trips or the counts changed
      if (hasNewTrips || tripsList.length !== trips.length) {
        console.log("Employee Credit Map from trips:", employeeCreditMap);
        
        // Update employees with calculated credits from trips
        setEmployees(prevEmployees => 
          prevEmployees.map(employee => ({
            ...employee,
            calculatedCredits: employeeCreditMap[employee.id] || 0
          }))
        );
        
        // Update the trips state
        setTrips(tripsList);
      }
    } catch (error) {
      console.error("Error fetching employee trips:", error);
      showToast('Failed to load trip data', 'error');
    }
  };

  // Optimize the calculateTotalOrgCredits function to handle batched queries
  const calculateTotalOrgCredits = async (orgId: string, employeeIds: string[]) => {
    try {
      // 1. Sum of credits earned by employees (from trips)
      let employeeEarnedCredits = 0;
      
      // Process employee IDs in batches for trips
      const batchSize = 10; // Firebase limit for 'in' queries
      
      // Process employee IDs in batches
      for (let i = 0; i < employeeIds.length; i += batchSize) {
        const batch = employeeIds.slice(i, i + batchSize);
        
        // Get all trips made by this batch of employees
        const tripsQuery = query(
          collection(db, 'trips'),
          where('userId', 'in', batch)
        );
        
        const tripsSnapshot = await getDocs(tripsQuery);
        
        tripsSnapshot.forEach(doc => {
          const tripData = doc.data();
          // Only count non-rejected trips
          if (!tripData.rejected) {
            employeeEarnedCredits += tripData.carbonCredits || 0;
          }
        });
      }
      
      // 2. Credits bought (completed purchase transactions)
      let boughtCredits = 0;
      
      // Get all completed purchases (buying credits)
      const purchasesQuery = query(
        collection(db, 'credit_transactions'),
        where('buyerOrgId', '==', orgId),
        where('status', '==', 'completed')
      );
      
      const purchasesSnapshot = await getDocs(purchasesQuery);
      purchasesSnapshot.forEach(doc => {
        const transactionData = doc.data();
        boughtCredits += transactionData.creditAmount || 0;
      });
      
      // 3. Credits sold (completed sales transactions)
      let soldCredits = 0;
      
      // Get all completed sales (selling credits)
      const salesQuery = query(
        collection(db, 'credit_transactions'),
        where('sellerOrgId', '==', orgId),
        where('status', '==', 'completed')
      );
      
      const salesSnapshot = await getDocs(salesQuery);
      salesSnapshot.forEach(doc => {
        const transactionData = doc.data();
        soldCredits += transactionData.creditAmount || 0;
      });
      
      // 4. Calculate total: earned + bought - sold
      const totalCredits = employeeEarnedCredits + boughtCredits - soldCredits;
      
      console.log('Credit calculation results:', {
        employeeEarnedCredits,
        boughtCredits,
        soldCredits,
        totalCredits
      });
      
      // Update states with the calculated values
      setEmployeeEarnedCredits(employeeEarnedCredits);
      setTotalOrgCredits(totalCredits);
      
      // Only update the database if there's a meaningful change
      const orgRef = doc(db, 'organizations', orgId);
      const orgDoc = await getDoc(orgRef);
      const currentData = orgDoc.data();
      
      if (
        currentData?.carbonCredits !== employeeEarnedCredits || 
        currentData?.totalCredits !== totalCredits
      ) {
        // Update the carbonCredits field (earned credits from employees only)
        // and totalCredits field (earned + bought - sold)
        await updateDoc(orgRef, {
          carbonCredits: employeeEarnedCredits,
          totalCredits: totalCredits
        });
        
        // Update local state
        if (currentOrganization) {
          setCurrentOrganization({
            ...currentOrganization,
            carbonCredits: employeeEarnedCredits,
            totalCredits: totalCredits
          });
        }
      }
      
      return totalCredits;
    } catch (error) {
      console.error("Error calculating total credits:", error);
      showToast('Failed to calculate total credits', 'error');
      return 0;
    }
  };

  const fetchPendingEmployees = async (domain: string) => {
    try {
      // Query the pending_employees collection
      const pendingEmployeesQuery = query(
        collection(db, 'pending_employees'),
        where('domain', '==', domain)
      );
      
      const pendingEmployeesSnapshot = await getDocs(pendingEmployeesQuery);
      const pendingEmployeesList: PendingEmployee[] = [];
      
      // For each pending employee, check if they have an approved user record
      for (const docSnapshot of pendingEmployeesSnapshot.docs) {
        const data = docSnapshot.data();
        
        // Check if this user is already approved in the users collection
        const userRef = doc(db, 'users', docSnapshot.id);
        const userDoc = await getDoc(userRef);
        
        // Only add to the pending list if the user doesn't exist or isn't approved
        if (!userDoc.exists() || userDoc.data()?.approved !== true) {
          pendingEmployeesList.push({
            id: docSnapshot.id,
            fullName: data.fullName || 'Unknown Employee',
            email: data.email || '',
            domain: data.domain || domain,
            createdAt: data.createdAt || ''
          });
        }
      }
      
      setPendingEmployees(pendingEmployeesList);
    } catch (error) {
      console.error("Error fetching pending employees:", error);
      showToast('Failed to load pending employees data', 'error');
    }
  };

  const handleEmployeeApproval = async (employeeId: string, approved: boolean) => {
    setIsProcessingApproval(true);
    try {
      // Get the pending employee details
      const pendingEmployeeRef = doc(db, 'pending_employees', employeeId);
      const pendingEmployeeDoc = await getDoc(pendingEmployeeRef);
      
      if (!pendingEmployeeDoc.exists()) {
        throw new Error('Pending employee not found');
      }
      
      const pendingEmployeeData = pendingEmployeeDoc.data();
      
      // Check if user document already exists
      const userRef = doc(db, 'users', employeeId);
      const userDoc = await getDoc(userRef);
      
      if (approved) {
        // Create or update the user document with approved status
        const userData = {
          name: pendingEmployeeData.fullName,
          email: pendingEmployeeData.email,
          domain: pendingEmployeeData.domain,
          orgId: pendingEmployeeData.orgId || null,
          role: 'employee',
          approved: true,
          carbonCredits: 0,
          createdAt: pendingEmployeeData.createdAt,
          lastLogin: new Date().toISOString()
        };
        
        if (userDoc.exists()) {
          // Update existing user document
          await updateDoc(userRef, {
            approved: true,
            // Update any other fields if needed
            lastLogin: new Date().toISOString()
          });
        } else {
          // Create new user document
          await setDoc(userRef, userData);
        }
        
        showToast('Employee approved successfully', 'success');
      } else {
        // Handle rejection
        if (userDoc.exists()) {
          // Update user document to indicate rejection
          await updateDoc(userRef, {
            approved: false,
            // Update any other fields if needed
            lastLogin: new Date().toISOString()
          });
        }
        
        showToast('Employee registration rejected', 'info');
      }
      
      // Refresh the pending employees list
      if (userData?.domain) {
        fetchPendingEmployees(userData.domain);
        fetchOrganizationEmployees(userData.domain);
      }
    } catch (error) {
      console.error('Error processing employee approval:', error);
      showToast('Failed to process employee approval', 'error');
    } finally {
      setIsProcessingApproval(false);
    }
  };

  const showToast = (message: string, type: ToastType['type']) => {
    setToast({ visible: true, message, type });
  };

  const hideToast = () => {
    setToast({ ...toast, visible: false });
  };

  // Filter employees based on search query only, since we've already filtered by role and approval
  const filteredEmployees = searchQuery.trim()
    ? employees.filter(employee => 
        employee.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        employee.email.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : employees;

  // Update the tableContainerStyle to ensure better scrolling functionality
  const tableContainerStyle = {
    maxHeight: '500px', // Increased from 400px to show more content
    borderRadius: '0.5rem',
    border: `1px solid ${colors.gray[200]}`,
    overflow: 'auto', // Ensure overflow is set to auto
    position: 'relative' as const, // Add position relative for proper scrollbar positioning
  };

  // Helper function to group trips by employee
  const getTripsByEmployee = (userId: string) => {
    return trips.filter(trip => trip.userId === userId);
  };

  // Helper function to calculate total credits by transport mode
  const getCreditsByTransportMode = () => {
    const creditsByMode: Record<string, number> = {
      walking: 0,
      cycling: 0,
      publicTransport: 0,
      rideShare: 0,
      ownVehicle: 0,
      workFromHome: 0,
      unknown: 0
    };
    
    trips.forEach(trip => {
      if (trip.isWorkFromHome) {
        creditsByMode.workFromHome += trip.carbonCredits;
      } else {
        creditsByMode[trip.transportMode] += trip.carbonCredits;
      }
    });
    
    return creditsByMode;
  };

  // Header and Container Styles
  const sectionHeaderStyle = {
    fontSize: '1.25rem',
    fontWeight: 600 as const,
    color: colors.gray[900],
    marginBottom: '0.5rem'
  };

  // Credit breakdown card component
  const CreditBreakdownCard = () => {
    const creditsByMode = getCreditsByTransportMode();
    
    return (
      <div style={{ backgroundColor: colors.white, borderRadius: '0.75rem', padding: '1.25rem', border: `1px solid ${colors.gray[200]}` }}>
        <h4 style={{ fontSize: '1rem', fontWeight: 600, color: colors.gray[800], marginBottom: '1rem' }}>
          Carbon Credits Explanation
        </h4>
        
        {/* Credit Types Explanation Section */}
        <div style={{ 
          backgroundColor: colors.gray[50], 
          padding: '1rem',
          borderRadius: '0.5rem',
          marginBottom: '1.5rem',
          border: `1px solid ${colors.gray[200]}`
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div>
              <h5 style={{ fontSize: '0.875rem', fontWeight: 600, color: colors.gray[800], margin: '0 0 0.375rem 0' }}>
                Employee Earned Credits: {employeeEarnedCredits.toFixed(2)}
              </h5>
              <p style={{ fontSize: '0.813rem', color: colors.gray[600], margin: 0 }}>
                Credits earned by employees through sustainable commuting practices. These represent the organization's positive environmental impact.
              </p>
            </div>
            
            <div>
              <h5 style={{ fontSize: '0.875rem', fontWeight: 600, color: colors.gray[800], margin: '0 0 0.375rem 0' }}>
                Available Credits: {totalOrgCredits.toFixed(2)}
              </h5>
              <p style={{ fontSize: '0.813rem', color: colors.gray[600], margin: 0 }}>
                Total credits available for trading = Employee Earned Credits + Credits Purchased - Credits Sold. This represents the organization's current carbon credit balance.
              </p>
            </div>
          </div>
        </div>
        
        <h4 style={{ fontSize: '1rem', fontWeight: 600, color: colors.gray[800], marginBottom: '1rem' }}>
          Credits by Transport Mode
        </h4>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {Object.entries(creditsByMode).map(([mode, credits]) => (
            credits > 0 && (
              <div key={mode} style={{ display: 'flex', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <div style={{ 
                    width: '0.75rem', 
                    height: '0.75rem', 
                    borderRadius: '50%', 
                    backgroundColor: 
                      mode === 'walking' ? colors.green[400] :
                      mode === 'cycling' ? colors.green[600] :
                      mode === 'publicTransport' ? colors.green[700] :
                      mode === 'rideShare' ? colors.green[300] :
                      mode === 'workFromHome' ? colors.green[500] :
                      colors.gray[400]
                  }} />
                  <span style={{ fontSize: '0.875rem', color: colors.gray[700] }}>
                    {mode === 'walking' ? 'Walking' :
                     mode === 'cycling' ? 'Cycling' :
                     mode === 'publicTransport' ? 'Public Transport' :
                     mode === 'rideShare' ? 'Ride Sharing' :
                     mode === 'ownVehicle' ? 'Own Vehicle' :
                     mode === 'workFromHome' ? 'Work From Home' : 'Unknown'}
                  </span>
                </div>
                <span style={{ fontSize: '0.875rem', fontWeight: 500, color: colors.green[700] }}>
                  {credits.toFixed(2)}
                </span>
              </div>
            )
          ))}
        </div>
      </div>
    );
  };

  // Add a function to get trips for a specific employee
  const getEmployeeTripDetails = (userId: string) => {
    const employeeTrips = trips.filter(trip => trip.userId === userId);
    
    // Group trips by date (month/year)
    const tripsByMonth: Record<string, TripData[]> = {};
    
    employeeTrips.forEach(trip => {
      const date = trip.tripDate;
      const monthYear = `${date.getMonth() + 1}/${date.getFullYear()}`;
      
      if (!tripsByMonth[monthYear]) {
        tripsByMonth[monthYear] = [];
      }
      
      tripsByMonth[monthYear].push(trip);
    });
    
    return {
      trips: employeeTrips,
      tripsByMonth,
      totalCredits: employeeTrips.reduce((sum, trip) => sum + trip.carbonCredits, 0)
    };
  };

  // Add a function to handle clicking on an employee's info icon
  const handleViewEmployeeCredits = (employee: Employee) => {
    setSelectedEmployee(employee);
    setShowCreditHistoryModal(true);
  };

  // Create an Employee Credits History Modal component
  const EmployeeCreditHistoryModal = () => {
    if (!selectedEmployee) return null;
    
    const { trips: employeeTrips, tripsByMonth, totalCredits } = getEmployeeTripDetails(selectedEmployee.id);
    
    // Use the calculated total from trips, not the value in the user record
    const displayedCredits = selectedEmployee.calculatedCredits !== undefined ? 
      selectedEmployee.calculatedCredits : totalCredits;
    
    // Improved scrollbar styling
    const scrollStyles = {
      height: '100%',
      overflowY: 'auto' as const,
      overflowX: 'hidden' as const,
      paddingRight: '4px',
    };

    return (
      <div style={styles.modal}>
        <div style={{...styles.modalContent, maxWidth: '48rem', maxHeight: '80vh', overflow: 'auto'}}>
          <div style={styles.modalHeader}>
            <h3 style={{ fontSize: '1.25rem', fontWeight: 600, color: colors.gray[900], margin: 0 }}>
              Credit History - {selectedEmployee.name}
            </h3>
            <p style={{ fontSize: '0.875rem', color: colors.gray[600], margin: '0.25rem 0 0 0' }}>
              Total Credits: {displayedCredits.toFixed(2)}
            </p>
          </div>
          
          <div 
            ref={creditHistoryScrollRef}
            style={{...styles.modalBody, padding: '1rem 1.5rem', maxHeight: '60vh', overflow: 'auto'}} 
            className={`${scrollbarStyles.scrollable} ${scrollbarStyles.scrollbarCustom}`}
          >
            {employeeTrips.length === 0 ? (
              <div style={styles.emptyState}>
                <p style={styles.emptyStateTitle}>No Trip Data</p>
                <p style={styles.emptyStateText}>
                  This employee hasn't recorded any trips yet.
                </p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                {/* Credit breakdown by transport mode */}
                <div style={{ backgroundColor: colors.green[50], padding: '1rem', borderRadius: '0.5rem' }}>
                  <h4 style={{ fontSize: '1rem', fontWeight: 600, color: colors.gray[800], marginBottom: '0.75rem' }}>
                    Credits by Transport Mode
                  </h4>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '0.75rem' }}>
                    {Object.entries(employeeTrips.reduce((acc, trip) => {
                      const mode = trip.isWorkFromHome ? 'workFromHome' : trip.transportMode;
                      acc[mode] = (acc[mode] || 0) + trip.carbonCredits;
                      return acc;
                    }, {} as Record<string, number>)).map(([mode, credits]) => (
                      <div key={mode} style={{ 
                        backgroundColor: colors.white, 
                        padding: '0.75rem', 
                        borderRadius: '0.375rem',
                        border: `1px solid ${colors.green[100]}`
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                          <div style={{ 
                            width: '0.75rem', 
                            height: '0.75rem', 
                            borderRadius: '50%', 
                            backgroundColor: 
                              mode === 'walking' ? colors.green[400] :
                              mode === 'cycling' ? colors.green[600] :
                              mode === 'publicTransport' ? colors.green[700] :
                              mode === 'rideShare' ? colors.green[300] :
                              mode === 'workFromHome' ? colors.green[500] :
                              colors.gray[400]
                          }} />
                          <span style={{ fontSize: '0.75rem', color: colors.gray[700] }}>
                            {mode === 'walking' ? 'Walking' :
                             mode === 'cycling' ? 'Cycling' :
                             mode === 'publicTransport' ? 'Public Transport' :
                             mode === 'rideShare' ? 'Ride Sharing' :
                             mode === 'ownVehicle' ? 'Own Vehicle' :
                             mode === 'workFromHome' ? 'Work From Home' : 'Unknown'}
                          </span>
                        </div>
                        <p style={{ fontSize: '1rem', fontWeight: 600, color: colors.green[700], margin: 0 }}>
                          {credits.toFixed(2)}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
                
                {/* Trip history by month */}
                <div>
                  <h4 style={{ fontSize: '1rem', fontWeight: 600, color: colors.gray[800], marginBottom: '0.75rem' }}>
                    Recent Trips
                  </h4>
                  
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    {employeeTrips
                      .sort((a, b) => b.tripDate.getTime() - a.tripDate.getTime())
                      .slice(0, 10)
                      .map(trip => (
                      <div key={trip.id} style={{ 
                        backgroundColor: colors.white, 
                        padding: '1rem', 
                        borderRadius: '0.5rem',
                        border: `1px solid ${colors.gray[200]}`,
                        boxShadow: '0 1px 2px rgba(0, 0, 0, 0.05)'
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <div style={{ 
                              width: '1.5rem', 
                              height: '1.5rem', 
                              borderRadius: '50%', 
                              backgroundColor: 
                                trip.transportMode === 'walking' ? colors.green[400] :
                                trip.transportMode === 'cycling' ? colors.green[600] :
                                trip.transportMode === 'publicTransport' ? colors.green[700] :
                                trip.transportMode === 'rideShare' ? colors.green[300] :
                                trip.isWorkFromHome ? colors.green[500] :
                                colors.gray[400],
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              color: colors.white,
                              fontSize: '0.75rem'
                            }}>
                              {trip.transportMode === 'walking' ? 'W' :
                               trip.transportMode === 'cycling' ? 'C' :
                               trip.transportMode === 'publicTransport' ? 'PT' :
                               trip.transportMode === 'rideShare' ? 'RS' :
                               trip.isWorkFromHome ? 'WFH' : '?'}
                            </div>
                            <span style={{ fontWeight: 500, color: colors.gray[900] }}>
                              {trip.isWorkFromHome ? 'Work From Home' : `${trip.transportMode.charAt(0).toUpperCase() + trip.transportMode.slice(1)} Trip`}
                            </span>
                          </div>
                          <span style={{ fontSize: '0.875rem', color: colors.gray[500] }}>
                            {trip.tripDate.toLocaleDateString()}
                          </span>
                        </div>
                        
                        {!trip.isWorkFromHome && (
                          <div style={{ fontSize: '0.875rem', color: colors.gray[600], marginBottom: '0.5rem' }}>
                            {trip.startAddress && trip.endAddress ? (
                              <>From: {trip.startAddress} <br />To: {trip.endAddress}</>
                            ) : (
                              <>Distance: {trip.distanceKm.toFixed(2)} km</>
                            )}
                          </div>
                        )}
                        
                        <div style={{ 
                          display: 'flex', 
                          justifyContent: 'space-between', 
                          alignItems: 'center',
                          marginTop: '0.5rem',
                          paddingTop: '0.5rem',
                          borderTop: `1px solid ${colors.gray[100]}`
                        }}>
                          <span style={{ fontSize: '0.875rem', color: colors.gray[600] }}>
                            Credits Earned
                          </span>
                          <span style={{ 
                            fontWeight: 600, 
                            color: colors.green[700],
                            fontSize: '1rem'
                          }}>
                            +{trip.carbonCredits.toFixed(2)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
          
          <div style={styles.modalFooter}>
            <button
              onClick={() => setShowCreditHistoryModal(false)}
              style={{
                ...styles.button,
                ...styles.secondaryButton,
                padding: '0.5rem 1rem',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = styles.secondaryButtonHover.backgroundColor;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = styles.secondaryButton.backgroundColor;
              }}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    );
  };

  // Add useEffect to fetch available sales
  useEffect(() => {
    if (currentOrganization) {
      fetchAvailableSales();
    }
  }, [currentOrganization]);

  // Function to fetch available credit sales
  const fetchAvailableSales = async (forceRefresh = false) => {
    if (!forceRefresh && availableSalesLoadedRef.current && availableSales.length > 0) {
      // Don't reload if already loaded unless forced
      return;
    }
    
    try {
      setIsLoadingSales(true);
      const salesQuery = query(
        collection(db, 'credit_transactions'),
        where('status', '==', 'approved')
      );
      
      const salesSnapshot = await getDocs(salesQuery);
      const salesList: CreditTransaction[] = [];
      
      salesSnapshot.forEach(doc => {
        const data = doc.data();
        salesList.push({
          id: doc.id,
          sellerOrgId: data.sellerOrgId,
          sellerOrgName: data.sellerOrgName,
          buyerOrgId: data.buyerOrgId || '',
          buyerOrgName: data.buyerOrgName || '',
          creditAmount: data.creditAmount,
          price: data.price,
          status: data.status,
          createdAt: data.createdAt
        });
      });
      
      setAvailableSales(salesList);
      setIsLoadingSales(false);
    } catch (error) {
      console.error("Error fetching available sales:", error);
      showToast('Failed to load available credit sales', 'error');
      setIsLoadingSales(false);
    }
  };

  // Function to post a new sale
  const handlePostSale = async () => {
    if (!currentOrganization) return;
    
    // Validate inputs
    const creditsToSell = parseFloat(creditAmount);
    const pricePerCredit = parseFloat(creditPrice);
    
    if (isNaN(creditsToSell) || creditsToSell <= 0) {
      setTransactionError('Please enter a valid credit amount greater than 0');
      return;
    }
    
    if (isNaN(pricePerCredit) || pricePerCredit <= 0) {
      setTransactionError('Please enter a valid price greater than 0');
      return;
    }
    
    // Use the organization's total credits for validation
    if (creditsToSell > currentOrganization.totalCredits) {
      setTransactionError(`You only have ${currentOrganization.totalCredits.toFixed(2)} credits available to sell`);
      return;
    }
    
    try {
      setIsProcessingTransaction(true);
      setTransactionError('');
      
      console.log('Posting new credit sale transaction...');
      console.log('Organization details:', {
        id: currentOrganization.id,
        name: currentOrganization.name
      });
      
      // Create a new transaction document
      const transactionRef = collection(db, 'credit_transactions');
      const newTransaction: Omit<CreditTransaction, 'id'> = {
        sellerOrgId: currentOrganization.id,
        sellerOrgName: currentOrganization.name,
        buyerOrgId: '',
        buyerOrgName: '',
        creditAmount: creditsToSell,
        price: pricePerCredit,
        status: 'pending',
        createdAt: serverTimestamp() // Use Firebase server timestamp
      };
      
      console.log('New transaction data:', newTransaction);
      
      const docRef = await addDoc(transactionRef, newTransaction);
      console.log('Transaction saved successfully with ID:', docRef.id);
      
      // When posting a sale, decrease the available trading credits (totalCredits)
      // This "reserves" the credits while the sale is pending
      const newTotalCredits = currentOrganization.totalCredits - creditsToSell;
      const orgRef = doc(db, 'organizations', currentOrganization.id);
      await updateDoc(orgRef, {
        totalCredits: newTotalCredits
      });
      
      // Update local state
      setCurrentOrganization({
        ...currentOrganization,
        totalCredits: newTotalCredits
      });
      
      // Show success message
      showToast('Credits listed for sale successfully', 'success');
      
      // Reset form and close modal
      setCreditAmount('');
      setCreditPrice('');
      setShowTransactionModal(false);
      setTransactionError('');
      
      // Refresh transaction history
      if (currentOrganization) {
        fetchTransactionHistory(currentOrganization.id, true);
      }
    } catch (error) {
      console.error("Error posting sale:", error);
      console.error("Error refreshing credits:", error);
      showToast('Failed to refresh credits', 'error');
    } finally {
      setLoading(false);
    }
  };

  // Function to fetch transaction history
  const fetchTransactionHistory = async (orgId: string, forceRefresh: boolean = false) => {
    try {
      // Allow manual refresh by resetting the ref
      if (forceRefresh) {
        transactionsLoadedRef.current = true;
      }
      
      setIsLoadingTransactions(true);
      
      // Query transactions where the organization is either the buyer or seller
      const buyerTransactionsQuery = query(
        collection(db, 'credit_transactions'),
        where('buyerOrgId', '==', orgId),
        orderBy('createdAt', 'desc')
      );
      
      const sellerTransactionsQuery = query(
        collection(db, 'credit_transactions'),
        where('sellerOrgId', '==', orgId),
        orderBy('createdAt', 'desc')
      );
      
      const [buyerSnapshot, sellerSnapshot] = await Promise.all([
        getDocs(buyerTransactionsQuery),
        getDocs(sellerTransactionsQuery)
      ]);
      
      const buyerTransactions: CreditTransaction[] = [];
      const sellerTransactions: CreditTransaction[] = [];
      
      buyerSnapshot.forEach(doc => {
        const data = doc.data();
        
        // Handle different date formats for createdAt
        let createdAtDate;
        if (data.createdAt) {
          if (data.createdAt.toDate && typeof data.createdAt.toDate === 'function') {
            // It's a Firebase Timestamp object
            createdAtDate = data.createdAt.toDate();
          } else if (typeof data.createdAt === 'string') {
            // It's a string (ISO format or other)
            createdAtDate = new Date(data.createdAt);
          } else {
            // Use current date as fallback
            createdAtDate = new Date();
          }
        } else {
          createdAtDate = new Date();
        }

        // Handle different date formats for completedAt
        let completedAtDate: Date | null = null;
        if (data.completedAt) {
          if (data.completedAt.toDate && typeof data.completedAt.toDate === 'function') {
            completedAtDate = data.completedAt.toDate();
          } else if (typeof data.completedAt === 'string') {
            completedAtDate = new Date(data.completedAt);
          }
        }
        
        buyerTransactions.push({
          id: doc.id,
          creditAmount: data.creditAmount,
          price: data.price,
          buyerOrgId: data.buyerOrgId,
          sellerOrgId: data.sellerOrgId,
          buyerOrgName: data.buyerOrgName || 'Unknown',
          sellerOrgName: data.sellerOrgName || 'Unknown',
          status: data.status || 'completed',
          createdAt: createdAtDate,
          completedAt: completedAtDate
        });
      });
      
      sellerSnapshot.forEach(doc => {
        const data = doc.data();
        
        // Handle different date formats for createdAt
        let createdAtDate;
        if (data.createdAt) {
          if (data.createdAt.toDate && typeof data.createdAt.toDate === 'function') {
            // It's a Firebase Timestamp object
            createdAtDate = data.createdAt.toDate();
          } else if (typeof data.createdAt === 'string') {
            // It's a string (ISO format or other)
            createdAtDate = new Date(data.createdAt);
          } else {
            // Use current date as fallback
            createdAtDate = new Date();
          }
        } else {
          createdAtDate = new Date();
        }

        // Handle different date formats for completedAt
        let completedAtDate: Date | null = null;
        if (data.completedAt) {
          if (data.completedAt.toDate && typeof data.completedAt.toDate === 'function') {
            completedAtDate = data.completedAt.toDate();
          } else if (typeof data.completedAt === 'string') {
            completedAtDate = new Date(data.completedAt);
          }
        }
        
        sellerTransactions.push({
          id: doc.id,
          creditAmount: data.creditAmount,
          price: data.price,
          buyerOrgId: data.buyerOrgId,
          sellerOrgId: data.sellerOrgId,
          buyerOrgName: data.buyerOrgName || 'Unknown',
          sellerOrgName: data.sellerOrgName || 'Unknown',
          status: data.status || 'completed',
          createdAt: createdAtDate,
          completedAt: completedAtDate
        });
      });
      
      // Combine both arrays and sort by date (newest first)
      const allTransactions = [...buyerTransactions, ...sellerTransactions].sort((a, b) => {
        // We've already converted createdAt to Date objects when creating the transaction objects
        // So we can safely assume they are Date objects here
        const dateA = a.createdAt instanceof Date ? a.createdAt.getTime() : 0;
        const dateB = b.createdAt instanceof Date ? b.createdAt.getTime() : 0;
        return dateB - dateA;
      });
      
      // Remove duplicate transactions (same id)
      const uniqueTransactions = allTransactions.filter((transaction, index, self) =>
        index === self.findIndex(t => t.id === transaction.id)
      );
      
      setTransactions(uniqueTransactions);
    } catch (error) {
      console.error("Error fetching transaction history:", error);
      showToast('Failed to load transaction history', 'error');
    } finally {
      setIsLoadingTransactions(false);
    }
  };

  // Function to handle buying credits
  const handleBuyCreditTransaction = async (sale: CreditTransaction) => {
    if (!currentOrganization) return;
    
    try {
      setIsProcessingTransaction(true);
      
      console.log('Processing credit purchase transaction...');
      console.log('Sale details:', sale);
      console.log('Organization details:', {
        id: currentOrganization.id,
        name: currentOrganization.name
      });
      
      // Update the transaction with buyer information
      const transactionRef = doc(db, 'credit_transactions', sale.id);
      await updateDoc(transactionRef, {
        buyerOrgId: currentOrganization.id,
        buyerOrgName: currentOrganization.name,
        status: 'pending_purchase',
        updatedAt: serverTimestamp() // Use Firebase server timestamp instead of string date
      });
      
      console.log('Transaction updated successfully');
      
      // Update local state to remove this sale from the available sales
      setAvailableSales(prevSales => 
        prevSales.filter(s => s.id !== sale.id)
      );
      
      // Show success message
      showToast('Purchase request submitted successfully', 'success');
      
      // Close modal
      setShowTransactionModal(false);
      
      // Refresh transaction history
      if (currentOrganization) {
        fetchTransactionHistory(currentOrganization.id, true);
      }
    } catch (error) {
      console.error("Error purchasing credits:", error);
      showToast('Failed to process purchase', 'error');
    } finally {
      setIsProcessingTransaction(false);
    }
  };

  // Add a new component to display all trips
  const AllEmployeeTripsTable = () => {
    // Create a map of employee IDs to names for displaying in the trips table
    const employeesMap: Record<string, string> = {};
    allEmployees.forEach(emp => {
      employeesMap[emp.id] = emp.name;
    });
    
    // Filter and sort trips
    const sortedTrips = [...trips].sort((a, b) => 
      new Date(b.tripDate).getTime() - new Date(a.tripDate).getTime()
    );
    
    return (
      <div style={{
        ...styles.card,
        marginBottom: '1.5rem',
      }}>
        <div style={styles.cardHeader || {
          padding: '1rem',
          borderBottom: `1px solid ${colors.gray[200]}`
        }}>
          <h3 style={styles.cardTitle || { fontSize: '1rem', fontWeight: 600, margin: 0 }}>All Employee Trips</h3>
        </div>
        
        <div 
          ref={employeeTripsScrollRef}
          style={{
            maxHeight: '400px',
            overflow: 'auto',
            borderRadius: '0.5rem',
            border: `1px solid ${colors.gray[200]}`
          }}
        >
          {sortedTrips.length === 0 ? (
            <div style={styles.emptyState || {
              padding: '2rem', 
              textAlign: 'center' as const,
              color: colors.gray[500]
            }}>
              <p>No trip data available yet</p>
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: '0.875rem' }}>
              <thead>
                <tr>
                  <th style={{ 
                    textAlign: 'left' as const, 
                    padding: '0.75rem 1rem', 
                    backgroundColor: colors.gray[50], 
                    borderBottom: `1px solid ${colors.gray[200]}`,
                    color: colors.gray[700],
                    fontWeight: 600
                  }}>
                    Employee
                  </th>
                  <th style={{ 
                    textAlign: 'left' as const, 
                    padding: '0.75rem 1rem', 
                    backgroundColor: colors.gray[50], 
                    borderBottom: `1px solid ${colors.gray[200]}`,
                    color: colors.gray[700],
                    fontWeight: 600
                  }}>
                    Date
                  </th>
                  <th style={{ 
                    textAlign: 'left' as const, 
                    padding: '0.75rem 1rem', 
                    backgroundColor: colors.gray[50], 
                    borderBottom: `1px solid ${colors.gray[200]}`,
                    color: colors.gray[700],
                    fontWeight: 600
                  }}>
                    Transport
                  </th>
                  <th style={{ 
                    textAlign: 'left' as const, 
                    padding: '0.75rem 1rem', 
                    backgroundColor: colors.gray[50], 
                    borderBottom: `1px solid ${colors.gray[200]}`,
                    color: colors.gray[700],
                    fontWeight: 600
                  }}>
                    Distance
                  </th>
                  <th style={{ 
                    textAlign: 'left' as const, 
                    padding: '0.75rem 1rem', 
                    backgroundColor: colors.gray[50], 
                    borderBottom: `1px solid ${colors.gray[200]}`,
                    color: colors.gray[700],
                    fontWeight: 600
                  }}>
                    Route
                  </th>
                  <th style={{ 
                    textAlign: 'left' as const, 
                    padding: '0.75rem 1rem', 
                    backgroundColor: colors.gray[50], 
                    borderBottom: `1px solid ${colors.gray[200]}`,
                    color: colors.gray[700],
                    fontWeight: 600
                  }}>
                    Credits
                  </th>
                  <th style={{ 
                    textAlign: 'left' as const, 
                    padding: '0.75rem 1rem', 
                    backgroundColor: colors.gray[50], 
                    borderBottom: `1px solid ${colors.gray[200]}`,
                    color: colors.gray[700],
                    fontWeight: 600
                  }}>
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedTrips.map((trip, index) => (
                  <tr key={trip.id || index} style={{ 
                    backgroundColor: index % 2 === 0 ? colors.white : colors.gray[50]
                  }}>
                    <td style={{ 
                      padding: '0.75rem 1rem', 
                      borderBottom: `1px solid ${colors.gray[200]}`,
                      color: colors.gray[900]
                    }}>
                      {employeesMap[trip.userId] || 'Unknown'}
                    </td>
                    <td style={{ 
                      padding: '0.75rem 1rem', 
                      borderBottom: `1px solid ${colors.gray[200]}`,
                      color: colors.gray[900]
                    }}>
                      {trip.tripDate ? new Date(trip.tripDate).toLocaleDateString() : 'N/A'}
                    </td>
                    <td style={{ 
                      padding: '0.75rem 1rem', 
                      borderBottom: `1px solid ${colors.gray[200]}`,
                      color: colors.gray[900]
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span style={{
                          display: 'inline-block',
                          width: '0.75rem',
                          height: '0.75rem',
                          borderRadius: '9999px',
                          backgroundColor: trip.transportMode === 'walking' ? colors.green[500] : 
                                          trip.transportMode === 'cycling' ? colors.green[600] :
                                          trip.transportMode === 'publicTransport' ? colors.green[700] :
                                          trip.transportMode === 'rideShare' ? colors.green[300] :
                                          trip.transportMode === 'ownVehicle' ? colors.red[400] :
                                          colors.gray[500]
                        }} />
                        {trip.transportMode ? trip.transportMode.charAt(0).toUpperCase() + trip.transportMode.slice(1).replace('_', ' ') : 'N/A'}
                      </div>
                    </td>
                    <td style={{ 
                      padding: '0.75rem 1rem', 
                      borderBottom: `1px solid ${colors.gray[200]}`,
                      color: colors.gray[900]
                    }}>
                      {trip.distanceKm ? `${trip.distanceKm.toFixed(1)} km` : 'N/A'}
                    </td>
                    <td style={{ 
                      padding: '0.75rem 1rem', 
                      borderBottom: `1px solid ${colors.gray[200]}`,
                      color: colors.gray[900]
                    }}>
                      {trip.startAddress && trip.endAddress ? 
                        `${trip.startAddress.substring(0, 15)}... → ${trip.endAddress.substring(0, 15)}...` : 
                        'N/A'}
                    </td>
                    <td style={{ 
                      padding: '0.75rem 1rem', 
                      borderBottom: `1px solid ${colors.gray[200]}`,
                      color: colors.gray[900],
                      fontWeight: 600
                    }}>
                      {trip.carbonCredits ? 
                        <span style={{ color: colors.green[600] }}>+{trip.carbonCredits.toFixed(2)}</span> : 
                        'N/A'}
                    </td>
                    <td style={{ 
                      padding: '0.75rem 1rem', 
                      borderBottom: `1px solid ${colors.gray[200]}`
                    }}>
                      {/* Trip status indicator */}
                      <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        backgroundColor: trip.rejected ? colors.red[100] : colors.green[100],
                        color: trip.rejected ? colors.red[800] : colors.green[800],
                        padding: '4px 8px',
                        borderRadius: '4px',
                        fontSize: '12px',
                        fontWeight: 'bold',
                      }}>
                        {trip.rejected ? (
                          <>
                            <XCircleIcon style={{ width: '16px', height: '16px' }} />
                            <span>Rejected</span>
                          </>
                        ) : (
                          <>
                            <CheckCircleIcon style={{ width: '16px', height: '16px' }} />
                            <span>Verified</span>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    );
  };

  // Fix the employee list section to ensure proper layout and style
  const EmployeeListSection = () => {
    // Helper function to get medal for top ranks
    const getRankDisplay = (index: number) => {
      if (index === 0) { // First place (Gold)
        return (
          <div style={{
            backgroundColor: '#FFD700',
            color: '#5F4C0B',
            borderRadius: '50%',
            width: '2rem',
            height: '2rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 'bold',
            fontSize: '1rem',
            boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
          }}>
            1
          </div>
        );
      } else if (index === 1) { // Second place (Silver)
        return (
          <div style={{
            backgroundColor: '#C0C0C0',
            color: '#494949',
            borderRadius: '50%',
            width: '2rem',
            height: '2rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 'bold',
            fontSize: '1rem',
            boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
          }}>
            2
          </div>
        );
      } else if (index === 2) { // Third place (Bronze)
        return (
          <div style={{
            backgroundColor: '#CD7F32',
            color: '#5C3817',
            borderRadius: '50%',
            width: '2rem',
            height: '2rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 'bold',
            fontSize: '1rem',
            boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
          }}>
            3
          </div>
        );
      } else {
        return (
          <div style={{
            backgroundColor: colors.gray[100],
            color: colors.gray[600],
            borderRadius: '50%',
            width: '2rem',
            height: '2rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 'bold',
            fontSize: '0.875rem'
          }}>
            {index + 1}
          </div>
        );
      }
    };

    return (
      <div style={{
        ...styles.card,
        marginBottom: '1.5rem',
      }}>
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '1rem',
          borderBottom: `1px solid ${colors.gray[200]}`
        }}>
          <h3 style={{
            ...styles.cardTitle || { fontSize: '1rem', fontWeight: 600, margin: 0 },
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem'
          }}>
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={colors.green[600]} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
            </svg>
            Employee Leaderboard
          </h3>
          
          <div style={{ 
            display: 'flex', 
            alignItems: 'center', 
            gap: '0.75rem',
            maxWidth: '20rem',
            width: '100%' 
          }}>
            <button
              onClick={refreshEmployeeCredits}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.25rem',
                padding: '0.5rem 0.75rem',
                backgroundColor: colors.green[50],
                color: colors.green[700],
                border: 'none',
                borderRadius: '0.375rem',
                fontSize: '0.75rem',
                fontWeight: 500,
                cursor: 'pointer',
                transition: 'all 0.2s ease'
              }}
              title="Refresh credits from trips data"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 2v6h6"></path>
                <path d="M3 13a9 9 0 1 0 3-7.7L3 8"></path>
              </svg>
              Refresh Credits
            </button>
            <div style={{
              position: 'relative',
              width: '100%'
            }}>
              <input
                type="text"
                placeholder="Search employees..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onFocus={() => setIsSearchFocused(true)}
                onBlur={() => setIsSearchFocused(false)}
                style={{
                  width: '100%',
                  padding: '0.5rem 0.75rem',
                  paddingLeft: '2rem',
                  borderRadius: '0.375rem',
                  border: `1px solid ${isSearchFocused ? colors.green[500] : colors.gray[300]}`,
                  outline: 'none',
                  fontSize: '0.875rem',
                  boxShadow: isSearchFocused ? `0 0 0 2px ${colors.green[200]}` : 'none',
                  transition: 'all 0.2s'
                }}
              />
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke={colors.gray[400]}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{
                  position: 'absolute',
                  left: '0.75rem',
                  top: '50%',
                  transform: 'translateY(-50%)'
                }}
              >
                <circle cx="11" cy="11" r="8"></circle>
                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
              </svg>
            </div>
          </div>
        </div>
        
        <div 
          ref={employeeListScrollRef}
          style={{
            maxHeight: '400px',
            overflow: 'auto',
          }}
        >
          {filteredEmps.length === 0 ? (
            <div style={styles.emptyState || {
              padding: '2rem', 
              textAlign: 'center' as const,
              color: colors.gray[500]
            }}>
              <p>No employees found</p>
            </div>
          ) : (
            <table style={styles.table || {
              width: '100%',
              borderCollapse: 'collapse' as const
            }}>
              <thead>
                <tr>
                  <th style={{
                    ...(styles.tableHeader || {
                      textAlign: 'left' as const,
                      padding: '0.75rem 1rem',
                      fontSize: '0.875rem',
                      fontWeight: 600,
                      color: colors.gray[700],
                      borderBottom: `1px solid ${colors.gray[200]}`
                    }),
                    width: '4rem',
                    textAlign: 'center' as const
                  }}>Rank</th>
                  <th style={styles.tableHeader || {
                    textAlign: 'left' as const,
                    padding: '0.75rem 1rem',
                    fontSize: '0.875rem',
                    fontWeight: 600,
                    color: colors.gray[700],
                    borderBottom: `1px solid ${colors.gray[200]}`
                  }}>Employee</th>
                  <th style={{
                    ...(styles.tableHeader || {
                      textAlign: 'left' as const,
                      padding: '0.75rem 1rem',
                      fontSize: '0.875rem',
                      fontWeight: 600,
                      color: colors.gray[700],
                      borderBottom: `1px solid ${colors.gray[200]}`
                    }),
                    textAlign: 'center' as const,
                    color: colors.green[700]
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.25rem' }}>
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 8c-2.2 0-4 1.8-4 4s1.8 4 4 4 4-1.8 4-4-1.8-4-4-4z"></path>
                        <path d="M12 2c-4.4 0-8 3.6-8 8 0 1.4.4 2.8 1 4l7 7 7-7c.6-1.2 1-2.6 1-4 0-4.4-3.6-8-8-8z"></path>
                      </svg>
                      Carbon Credits
                    </div>
                  </th>
                  <th style={styles.tableHeader || {
                    textAlign: 'left' as const,
                    padding: '0.75rem 1rem',
                    fontSize: '0.875rem',
                    fontWeight: 600,
                    color: colors.gray[700],
                    borderBottom: `1px solid ${colors.gray[200]}`
                  }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredEmps.map((employee, index) => {
                  // Determine background color based on position
                  const isTopThree = index < 3;
                  const rowBackground = isTopThree 
                    ? index === 0 
                      ? 'rgba(255, 215, 0, 0.05)' 
                      : index === 1 
                        ? 'rgba(192, 192, 192, 0.05)' 
                        : 'rgba(205, 127, 50, 0.05)'
                    : '';
                  
                  return (
                    <tr 
                      key={employee.id} 
                      style={{
                        ...(styles.tableRow || {
                          borderBottom: `1px solid ${colors.gray[100]}`
                        }),
                        ...(employee.status === 'inactive' || employee.approved === false ? {
                          backgroundColor: colors.gray[50],
                          color: colors.gray[500]
                        } : { backgroundColor: rowBackground }),
                        transition: 'background-color 0.3s'
                      }}
                    >
                      <td style={{
                        ...(styles.tableCell || {
                          padding: '0.75rem 1rem',
                          fontSize: '0.875rem',
                          color: colors.gray[800]
                        }),
                        textAlign: 'center',
                        padding: '1rem 0.5rem'
                      }}>
                        {getRankDisplay(index)}
                      </td>
                      <td style={styles.tableCell || {
                        padding: '0.75rem 1rem',
                        fontSize: '0.875rem',
                        color: colors.gray[800]
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                          <div style={{ 
                            width: '2.5rem',
                            height: '2.5rem',
                            borderRadius: '50%',
                            backgroundColor: employee.status === 'inactive' || employee.approved === false ? colors.gray[200] : colors.green[100],
                            color: employee.status === 'inactive' || employee.approved === false ? colors.gray[500] : colors.green[700],
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontWeight: 600,
                            fontSize: '1rem'
                          }}>
                            {employee.name.charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <p style={{ 
                              margin: 0, 
                              fontWeight: 500, 
                              fontSize: '0.9rem',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.5rem'
                            }}>
                              {employee.name}
                              {(employee.status === 'inactive' || employee.approved === false) && (
                                <span style={{
                                  fontSize: '0.7rem',
                                  fontWeight: 400,
                                  color: colors.white,
                                  backgroundColor: colors.red[500],
                                  padding: '0.125rem 0.375rem',
                                  borderRadius: '0.25rem',
                                  display: 'inline-block',
                                  textTransform: 'uppercase',
                                  lineHeight: 1
                                }}>
                                  Deactivated
                                </span>
                              )}
                            </p>
                            <p style={{ margin: 0, fontSize: '0.75rem', color: colors.gray[500] }}>
                              {employee.email}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td style={{
                        ...(styles.tableCell || {
                          padding: '0.75rem 1rem',
                          fontSize: '0.875rem',
                          color: colors.gray[800]
                        }),
                        textAlign: 'center',
                        padding: '0.75rem'
                      }}>
                        <div style={{
                          display: 'inline-flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'center',
                          padding: '0.5rem 0.75rem',
                          background: isTopThree 
                            ? index === 0 
                              ? 'rgba(255, 215, 0, 0.1)' 
                              : index === 1 
                                ? 'rgba(192, 192, 192, 0.1)' 
                                : 'rgba(205, 127, 50, 0.1)'
                            : colors.green[50],
                          borderRadius: '0.375rem',
                          minWidth: '5rem'
                        }}>
                          <span style={{ 
                            fontSize: '1.125rem', 
                            fontWeight: 700, 
                            color: isTopThree 
                              ? index === 0 
                                ? 'rgb(184, 134, 11)' 
                                : index === 1 
                                  ? 'rgb(80, 80, 80)' 
                                  : 'rgb(140, 62, 15)'
                              : colors.green[700]
                          }}>
                            {employee.calculatedCredits?.toFixed(2) || '0.00'}
                          </span>
                          <span style={{ 
                            fontSize: '0.7rem', 
                            fontWeight: 500, 
                            color: colors.gray[600],
                            marginTop: '0.125rem'
                          }}>
                            CREDITS EARNED
                          </span>
                        </div>
                      </td>
                      <td style={styles.tableCell || {
                        padding: '0.75rem 1rem',
                        fontSize: '0.875rem',
                        color: colors.gray[800]
                      }}>
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                          <button
                            onClick={() => handleViewEmployeeCredits(employee)}
                            style={{
                              ...styles.textButton,
                              backgroundColor: colors.green[50],
                              color: colors.green[700],
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.25rem'
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.backgroundColor = colors.green[100];
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.backgroundColor = colors.green[50];
                            }}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <circle cx="12" cy="12" r="10"></circle>
                              <line x1="12" y1="16" x2="12" y2="12"></line>
                              <line x1="12" y1="8" x2="12.01" y2="8"></line>
                            </svg>
                            View Details
                          </button>
                          
                          {employee.status !== 'inactive' && employee.approved !== false && (
                            <button
                              onClick={() => {
                                setEmployeeToDelete(employee);
                                setShowDeleteModal(true);
                              }}
                              style={{
                                backgroundColor: 'transparent',
                                border: 'none',
                                color: colors.red[600],
                                cursor: 'pointer',
                                padding: '0.25rem 0.5rem',
                                borderRadius: '0.25rem',
                                fontSize: '0.75rem',
                                fontWeight: 500,
                                transition: 'background-color 0.2s ease',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.25rem'
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.backgroundColor = colors.red[50];
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.backgroundColor = 'transparent';
                              }}
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M3 6h18"></path>
                                <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
                                <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
                                <line x1="10" y1="11" x2="10" y2="17"></line>
                                <line x1="14" y1="11" x2="14" y2="17"></line>
                              </svg>
                              Deactivate
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    );
  };

  const handleEmployeeDelete = async (employeeId: string) => {
    if (!currentOrganization) return;
    
    try {
      setIsDeleting(true);
      
      // First check if the employee exists
      const employeeTrips = getTripsByEmployee(employeeId);
      const employee = employees.find(emp => emp.id === employeeId);
      
      if (!employee) {
        throw new Error('Employee not found');
      }

      // Use Firebase directly to update the user status instead of an API endpoint
      // This approach avoids the need for a separate API route
      const userRef = doc(db, 'users', employeeId);
      
      await updateDoc(userRef, {
        status: 'inactive',
        approved: false, // Set approved to false to prevent login
        active: false, // Additional flag to mark account as inactive
        deactivatedAt: new Date().toISOString(),
        deactivatedBy: userData?.uid || user?.uid
      });
      
      // Update local state by marking the employee as inactive
      setEmployees(prevEmployees => 
        prevEmployees.map(emp => 
          emp.id === employeeId 
            ? { ...emp, status: 'inactive', approved: false, active: false } 
            : emp
        )
      );
      
      // Show success toast
      showToast(`Employee ${employee.name} has been deactivated`, 'success');
      
      // Close the modal
      setShowDeleteModal(false);
      setEmployeeToDelete(null);
    } catch (error) {
      console.error('Error deactivating employee:', error);
      
      // Proper error handling without trying to parse JSON
      let errorMessage = 'Failed to deactivate employee';
      if (error instanceof Error) {
        errorMessage = error.message;
      }
      
      showToast(errorMessage, 'error');
    } finally {
      setIsDeleting(false);
    }
  };

  const DeleteConfirmationModal = () => {
    if (!employeeToDelete) return null;
    
    return (
      <div style={styles.modal}>
        <div style={{
          ...styles.modalContent,
          borderRadius: '0.75rem',
          boxShadow: '0 4px 20px rgba(0, 0, 0, 0.15)',
          maxWidth: '450px'
        }}>
          <div style={{
            ...styles.modalHeader,
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            borderBottom: `1px solid ${colors.gray[200]}`,
            padding: '1.25rem'
          }}>
            <div style={{ 
              background: colors.red[100], 
              borderRadius: '50%', 
              width: '2.5rem', 
              height: '2.5rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: colors.red[600]
            }}>
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="8" y1="12" x2="16" y2="12"></line>
              </svg>
            </div>
            <h3 style={{
              ...styles.modalTitle,
              fontSize: '1.25rem',
              fontWeight: 600,
              color: colors.gray[900],
              margin: 0
            }}>
              Deactivate Employee
            </h3>
          </div>
          
          <div style={{...styles.modalBody, padding: '1.25rem'}}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <p style={{ margin: 0, fontSize: '0.938rem', color: colors.gray[700] }}>
                Are you sure you want to deactivate the employee <strong>{employeeToDelete.name}</strong>?
              </p>
              
              <div style={{ 
                padding: '0.75rem',
                backgroundColor: colors.red[50],
                borderRadius: '0.5rem',
                border: `1px solid ${colors.red[100]}`
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={colors.red[600]} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="8" x2="12" y2="12"></line>
                    <line x1="12" y1="16" x2="12.01" y2="16"></line>
                  </svg>
                  <p style={{ margin: 0, fontSize: '0.875rem', color: colors.red[700] }}>
                    This action will revoke this employee's access to the system. Their data will be retained for record-keeping purposes.
                  </p>
                </div>
              </div>
            </div>
          </div>
          
          <div style={{
            ...styles.modalFooter,
            display: 'flex', 
            justifyContent: 'flex-end',
            gap: '0.75rem',
            padding: '1.25rem',
            borderTop: `1px solid ${colors.gray[200]}`
          }}>
            <button
              onClick={() => {
                setShowDeleteModal(false);
                setEmployeeToDelete(null);
              }}
              style={{
                background: colors.white,
                color: colors.gray[700],
                border: `1px solid ${colors.gray[300]}`,
                borderRadius: '0.5rem',
                padding: '0.75rem 1.25rem',
                fontSize: '0.875rem',
                fontWeight: 500,
                cursor: 'pointer',
                transition: 'all 0.2s ease'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = colors.gray[50];
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = colors.white;
              }}
            >
              Cancel
            </button>
            
            <button
              onClick={() => handleEmployeeDelete(employeeToDelete.id)}
              disabled={isDeleting}
              style={{
                background: colors.red[600],
                color: 'white',
                border: 'none',
                borderRadius: '0.5rem',
                padding: '0.75rem 1.25rem',
                fontSize: '0.875rem',
                fontWeight: 500,
                cursor: isDeleting ? 'not-allowed' : 'pointer',
                opacity: isDeleting ? 0.7 : 1,
                transition: 'all 0.2s ease',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem'
              }}
              onMouseEnter={(e) => !isDeleting && (e.currentTarget.style.background = colors.red[700])}
              onMouseLeave={(e) => !isDeleting && (e.currentTarget.style.background = colors.red[600])}
            >
              {isDeleting ? (
                <>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ animation: 'spin 1s linear infinite'}}>
                    <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.3)" strokeWidth="4" />
                    <path d="M12 2C6.47715 2 2 6.47715 2 12" stroke="white" strokeWidth="4" />
                  </svg>
                  Processing...
                </>
              ) : (
                <>
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="8" y1="12" x2="16" y2="12"></line>
                  </svg>
                  Deactivate Employee
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    );
  };

  // Add a new component to display transaction history
  const TransactionHistorySection = () => {
    // Function to handle manual refresh
    const handleRefresh = () => {
      if (currentOrganization) {
        // Store current scroll position before refresh
        preserveScrollPosition(transactionHistoryScrollRef);
        
        // Fetch new data with force refresh
        fetchTransactionHistory(currentOrganization.id, true);
      }
    };
    
    return (
      <>
        <div style={styles.sectionTitle || { 
          display: 'flex', 
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '1rem'
        }}>
          <h3 style={{ margin: 0 }}>Transaction History</h3>
          <button
            onClick={handleRefresh}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.375rem',
              padding: '0.5rem 0.75rem',
              backgroundColor: 'white',
              color: colors.gray[700],
              border: `1px solid ${colors.gray[300]}`,
              borderRadius: '0.375rem',
              fontSize: '0.75rem',
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'all 0.2s ease'
            }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 2v6h6"></path>
              <path d="M3 13a9 9 0 1 0 3-7.7L3 8"></path>
            </svg>
            Refresh
          </button>
        </div>
        
        <div style={{
          ...styles.card,
          marginBottom: '1.5rem'
        }}>
          {isLoadingTransactions ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="animate-spin">
                <circle cx="12" cy="12" r="10" stroke={colors.gray[300]} strokeWidth="4" />
                <path d="M12 2C6.47715 2 2 6.47715 2 12" stroke={colors.green[500]} strokeWidth="4" />
              </svg>
            </div>
          ) : transactions.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '2rem' }}>
              <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke={colors.gray[400]} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: '0.75rem' }}>
                <rect x="2" y="5" width="20" height="14" rx="2" />
                <line x1="2" y1="10" x2="22" y2="10" />
              </svg>
              <p style={{ margin: 0, color: colors.gray[600] }}>No transactions found</p>
              <p style={{ margin: '0.5rem 0 0 0', fontSize: '0.875rem', color: colors.gray[500] }}>
                Buy or sell credits to start tracking your transactions
              </p>
            </div>
          ) : (
            <div 
              ref={transactionHistoryScrollRef}
              style={{ 
                overflow: 'auto', 
                maxHeight: '300px',
                padding: '0.25rem'
              }} 
              className={`${scrollbarStyles.scrollable} ${scrollbarStyles.scrollbarCustom}`}
            >
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{
                      padding: '0.75rem',
                      textAlign: 'left',
                      fontSize: '0.875rem',
                      fontWeight: 600,
                      color: colors.gray[700],
                      borderBottom: `1px solid ${colors.gray[200]}`
                    }}>Date</th>
                    <th style={{
                      padding: '0.75rem',
                      textAlign: 'left',
                      fontSize: '0.875rem',
                      fontWeight: 600,
                      color: colors.gray[700],
                      borderBottom: `1px solid ${colors.gray[200]}`
                    }}>Type</th>
                    <th style={{
                      padding: '0.75rem',
                      textAlign: 'left',
                      fontSize: '0.875rem',
                      fontWeight: 600,
                      color: colors.gray[700],
                      borderBottom: `1px solid ${colors.gray[200]}`
                    }}>Organization</th>
                    <th style={{
                      padding: '0.75rem',
                      textAlign: 'right',
                      fontSize: '0.875rem',
                      fontWeight: 600,
                      color: colors.gray[700],
                      borderBottom: `1px solid ${colors.gray[200]}`
                    }}>Credits</th>
                    <th style={{
                      padding: '0.75rem',
                      textAlign: 'right',
                      fontSize: '0.875rem',
                      fontWeight: 600,
                      color: colors.gray[700],
                      borderBottom: `1px solid ${colors.gray[200]}`
                    }}>Price</th>
                    <th style={{
                      padding: '0.75rem',
                      textAlign: 'right',
                      fontSize: '0.875rem',
                      fontWeight: 600,
                      color: colors.gray[700],
                      borderBottom: `1px solid ${colors.gray[200]}`
                    }}>Total</th>
                    <th style={{
                      padding: '0.75rem',
                      textAlign: 'center',
                      fontSize: '0.875rem',
                      fontWeight: 600,
                      color: colors.gray[700],
                      borderBottom: `1px solid ${colors.gray[200]}`
                    }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((transaction) => {
                    const isBuyer = transaction.buyerOrgId === currentOrganization?.id;
                    const counterpartyName = isBuyer ? transaction.sellerOrgName : transaction.buyerOrgName;
                    
                    return (
                      <tr key={transaction.id}>
                        <td style={{
                          padding: '0.75rem',
                          fontSize: '0.875rem',
                          color: colors.gray[800],
                          borderBottom: `1px solid ${colors.gray[200]}`
                        }}>
                          {transaction.createdAt instanceof Date 
                            ? transaction.createdAt.toLocaleDateString() 
                            : typeof transaction.createdAt === 'string'
                              ? new Date(transaction.createdAt).toLocaleDateString()
                              : 'N/A'}
                        </td>
                        <td style={{
                          padding: '0.75rem',
                          fontSize: '0.875rem',
                          color: colors.gray[800],
                          borderBottom: `1px solid ${colors.gray[200]}`
                        }}>
                          <div style={{ 
                            display: 'flex', 
                            alignItems: 'center', 
                            gap: '0.375rem'
                          }}>
                            <div style={{ 
                              width: '0.5rem', 
                              height: '0.5rem', 
                              borderRadius: '50%', 
                              backgroundColor: isBuyer ? colors.green[500] : colors.gray[500] 
                            }} />
                            {isBuyer ? 'Buy' : 'Sell'}
                          </div>
                        </td>
                        <td style={{
                          padding: '0.75rem',
                          fontSize: '0.875rem',
                          color: colors.gray[800],
                          borderBottom: `1px solid ${colors.gray[200]}`
                        }}>
                          {counterpartyName}
                        </td>
                        <td style={{
                          padding: '0.75rem',
                          fontSize: '0.875rem',
                          color: colors.gray[800],
                          borderBottom: `1px solid ${colors.gray[200]}`,
                          textAlign: 'right',
                          fontWeight: 500
                        }}>
                          {transaction.creditAmount.toFixed(2)}
                        </td>
                        <td style={{
                          padding: '0.75rem',
                          fontSize: '0.875rem',
                          color: colors.gray[800],
                          borderBottom: `1px solid ${colors.gray[200]}`,
                          textAlign: 'right'
                        }}>
                          ${transaction.price.toFixed(2)}
                        </td>
                        <td style={{
                          padding: '0.75rem',
                          fontSize: '0.875rem',
                          color: colors.gray[800],
                          borderBottom: `1px solid ${colors.gray[200]}`,
                          textAlign: 'right',
                          fontWeight: 600
                        }}>
                          ${(transaction.creditAmount * transaction.price).toFixed(2)}
                        </td>
                        <td style={{
                          padding: '0.75rem',
                          fontSize: '0.75rem',
                          borderBottom: `1px solid ${colors.gray[200]}`,
                          textAlign: 'center'
                        }}>
                          <span style={{
                            display: 'inline-block',
                            padding: '0.25rem 0.5rem',
                            borderRadius: '1rem',
                            backgroundColor: 
                              transaction.status === 'completed' ? colors.green[50] :
                              transaction.status === 'approved' ? colors.green[50] :
                              transaction.status === 'pending' ? colors.gray[100] :
                              colors.red[50],
                            color: 
                              transaction.status === 'completed' ? colors.green[700] :
                              transaction.status === 'approved' ? colors.green[700] :
                              transaction.status === 'pending' ? colors.gray[700] :
                              colors.red[700],
                            textTransform: 'capitalize' as const
                          }}>
                            {transaction.status}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </>
    );
  };

  // Add the TransactionModal component before the EmployerDashboard return statement
  const TransactionModal = () => {
    if (!currentOrganization) return null;
    
    // Function to handle manual refresh of available sales
    const handleRefreshSales = () => {
      if (currentOrganization) {
        // Store current scroll position before refresh
        preserveScrollPosition(availableSalesScrollRef);
        
        // Force refresh of sales data
        fetchAvailableSales(true);
      }
    };
    
    return (
      <div style={styles.modal}>
        <div style={{
          ...styles.modalContent,
          borderRadius: '0.75rem',
          boxShadow: '0 4px 20px rgba(0, 0, 0, 0.15)',
          maxWidth: '500px'
        }}>
          <div style={{
            ...styles.modalHeader,
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            borderBottom: `1px solid ${colors.gray[200]}`,
            padding: '1.25rem'
          }}>
            {transactionType === 'sell' ? (
              <div style={{
                background: colors.green[100], 
                borderRadius: '50%',
                width: '2.5rem', 
                height: '2.5rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: colors.green[600]
              }}>
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"></circle>
                  <polyline points="8 12 12 16 16 12"></polyline>
                  <line x1="12" y1="8" x2="12" y2="16"></line>
                </svg>
              </div>
            ) : (
              <div style={{
                background: colors.green[100], 
                borderRadius: '50%',
                width: '2.5rem', 
                height: '2.5rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: colors.green[600]
              }}>
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"></circle>
                  <line x1="12" y1="8" x2="12" y2="16"></line>
                  <line x1="8" y1="12" x2="16" y2="12"></line>
                </svg>
              </div>
            )}
            <div>
              <h3 style={{
                fontSize: '1.25rem',
                fontWeight: 600,
                color: colors.gray[900],
                margin: 0
              }}>
                {transactionType === 'sell' ? 'Sell Carbon Credits' : 'Buy Carbon Credits'}
              </h3>
              <p style={{ 
                fontSize: '0.875rem', 
                color: colors.gray[600], 
                margin: '0.25rem 0 0 0'
              }}>
                {transactionType === 'sell' 
                  ? 'List your carbon credits for sale to other organizations' 
                  : 'Purchase carbon credits from other organizations'}
              </p>
            </div>
          </div>
          
          <div style={{padding: '1.25rem'}}>
            {transactionError && (
              <div style={{ 
                backgroundColor: colors.red[50], 
                padding: '0.75rem', 
                borderRadius: '0.5rem',
                border: `1px solid ${colors.red[100]}`,
                marginBottom: '1rem'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={colors.red[600]} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="8" x2="12" y2="12"></line>
                    <line x1="12" y1="16" x2="12.01" y2="16"></line>
                  </svg>
                  <p style={{ margin: 0, fontSize: '0.875rem', fontWeight: 500, color: colors.red[700] }}>
                    {transactionError}
                  </p>
                </div>
              </div>
            )}
            
            {transactionType === 'sell' ? (
              // Sell Credits Form
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                <div style={{
                  background: colors.green[50], 
                  padding: '1rem', 
                  borderRadius: '0.5rem',
                  border: `1px solid ${colors.green[100]}`
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={colors.green[600]} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 1v22"></path>
                      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path>
                    </svg>
                    <p style={{ 
                      fontSize: '0.875rem', 
                      color: colors.gray[700], 
                      margin: 0
                    }}>
                      Available to sell: <span style={{ fontWeight: 600, color: colors.green[700] }}>{currentOrganization.totalCredits.toFixed(2)}</span> credits
                    </p>
                  </div>
                </div>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <label htmlFor="creditAmount" style={{ fontSize: '0.875rem', fontWeight: 500, color: colors.gray[700] }}>
                    Number of Credits to Sell
                  </label>
                  <input
                    id="creditAmount"
                    type="number"
                    value={creditAmount}
                    onChange={(e) => setCreditAmount(e.target.value)}
                    placeholder="Enter amount"
                    style={{
                      padding: '0.75rem',
                      borderRadius: '0.375rem',
                      border: `1px solid ${colors.gray[300]}`,
                      fontSize: '0.875rem',
                      width: '100%',
                      boxSizing: 'border-box' as const
                    }}
                    min="0.01"
                    max={currentOrganization.totalCredits.toString()}
                    step="0.01"
                  />
                </div>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <label htmlFor="creditPrice" style={{ fontSize: '0.875rem', fontWeight: 500, color: colors.gray[700] }}>
                    Price per Credit (USD)
                  </label>
                  <input
                    id="creditPrice"
                    type="number"
                    value={creditPrice}
                    onChange={(e) => setCreditPrice(e.target.value)}
                    placeholder="Enter price"
                    style={{
                      padding: '0.75rem',
                      borderRadius: '0.375rem',
                      border: `1px solid ${colors.gray[300]}`,
                      fontSize: '0.875rem',
                      width: '100%',
                      boxSizing: 'border-box' as const
                    }}
                    min="0.01"
                    step="0.01"
                  />
                </div>
                
                {parseFloat(creditAmount) > 0 && parseFloat(creditPrice) > 0 && (
                  <div style={{ 
                    backgroundColor: colors.green[50], 
                    padding: '1rem', 
                    borderRadius: '0.5rem',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    border: `1px solid ${colors.green[100]}`
                  }}>
                    <p style={{ margin: 0, fontSize: '0.875rem', fontWeight: 500, color: colors.gray[700] }}>
                      Total sale value:
                    </p>
                    <p style={{ margin: 0, fontSize: '1.125rem', fontWeight: 600, color: colors.green[700] }}>
                      ${(parseFloat(creditAmount) * parseFloat(creditPrice)).toFixed(2)}
                    </p>
                  </div>
                )}
                
                <p style={{ 
                  fontSize: '0.75rem', 
                  color: colors.gray[500], 
                  margin: 0,
                  background: colors.gray[50],
                  padding: '0.75rem',
                  borderRadius: '0.375rem'
                }}>
                  <strong>Note:</strong> Your sale will be reviewed by the bank before being made available to buyers.
                </p>
              </div>
            ) : (
              // Buy Credits View
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                <div style={{ 
                  display: 'flex', 
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '0.5rem'
                }}>
                  <p style={{ 
                    fontSize: '0.875rem', 
                    color: colors.gray[700],
                    background: colors.gray[50],
                    padding: '0.75rem',
                    borderRadius: '0.5rem',
                    margin: 0,
                    flex: 1
                  }}>
                    Select a credit package below to purchase:
                  </p>
                  <button
                    onClick={handleRefreshSales}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      padding: '0.5rem',
                      backgroundColor: 'transparent',
                      color: colors.gray[500],
                      border: 'none',
                      borderRadius: '0.375rem',
                      fontSize: '0.75rem',
                      cursor: 'pointer',
                      transition: 'all 0.2s ease'
                    }}
                    title="Refresh available sales"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 2v6h6"></path>
                      <path d="M3 13a9 9 0 1 0 3-7.7L3 8"></path>
                    </svg>
                  </button>
                </div>
                
                {isLoadingSales ? (
                  <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="animate-spin">
                      <circle cx="12" cy="12" r="10" stroke={colors.gray[300]} strokeWidth="4" />
                      <path d="M12 2C6.47715 2 2 6.47715 2 12" stroke={colors.green[500]} strokeWidth="4" />
                    </svg>
                  </div>
                ) : availableSales.length === 0 ? (
                  <div style={{ 
                    backgroundColor: colors.gray[50], 
                    padding: '2rem', 
                    borderRadius: '0.5rem', 
                    textAlign: 'center',
                    border: `1px solid ${colors.gray[200]}`
                  }}>
                    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke={colors.gray[400]} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: '1rem' }}>
                      <circle cx="12" cy="12" r="10"></circle>
                      <line x1="8" y1="12" x2="16" y2="12"></line>
                    </svg>
                    <p style={{ margin: 0, fontSize: '0.938rem', color: colors.gray[700], fontWeight: 500 }}>
                      No Credit Packages Available
                    </p>
                    <p style={{ margin: '0.5rem 0 0 0', fontSize: '0.875rem', color: colors.gray[600] }}>
                      Check back later for available credit packages to purchase.
                    </p>
                  </div>
                ) : (
                  <div 
                    ref={availableSalesScrollRef}
                    style={{ 
                      display: 'flex', 
                      flexDirection: 'column', 
                      gap: '0.75rem', 
                      maxHeight: '300px', 
                      overflowY: 'auto',
                      padding: '0.25rem'
                    }} 
                    className={`${scrollbarStyles.scrollable} ${scrollbarStyles.scrollbarCustom}`}
                  >
                    {availableSales
                      .filter(sale => sale.sellerOrgId !== currentOrganization.id) // Don't show your own sales
                      .map(sale => (
                      <div 
                        key={sale.id} 
                        style={{ 
                          border: `1px solid ${colors.gray[200]}`,
                          borderRadius: '0.75rem',
                          padding: '1rem',
                          backgroundColor: colors.white,
                          transition: 'all 0.2s ease',
                          boxShadow: '0 1px 3px rgba(0, 0, 0, 0.05)'
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <div style={{ 
                              background: colors.green[50],
                              width: '2rem',
                              height: '2rem',
                              borderRadius: '50%',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              color: colors.green[600],
                              fontSize: '0.75rem',
                              fontWeight: 600
                            }}>
                              {sale.sellerOrgName.substring(0, 1).toUpperCase()}
                            </div>
                            <p style={{ margin: 0, fontSize: '0.938rem', fontWeight: 500, color: colors.gray[900] }}>
                              {sale.sellerOrgName}
                            </p>
                          </div>
                          <span style={{ 
                            fontSize: '0.75rem', 
                            color: colors.gray[500],
                            background: colors.gray[50],
                            padding: '0.25rem 0.5rem',
                            borderRadius: '1rem'
                          }}>
                            {new Date(sale.createdAt).toLocaleDateString()}
                          </span>
                        </div>
                        
                        <div style={{ 
                          display: 'grid', 
                          gridTemplateColumns: 'repeat(3, 1fr)', 
                          gap: '0.5rem',
                          marginBottom: '1rem',
                          background: colors.gray[50],
                          padding: '0.75rem',
                          borderRadius: '0.5rem'
                        }}>
                          <div>
                            <p style={{ margin: 0, fontSize: '0.75rem', color: colors.gray[600] }}>
                              Credits
                            </p>
                            <p style={{ margin: '0.25rem 0 0 0', fontSize: '1.125rem', fontWeight: 600, color: colors.green[700] }}>
                              {sale.creditAmount.toFixed(2)}
                            </p>
                          </div>
                          
                          <div>
                            <p style={{ margin: 0, fontSize: '0.75rem', color: colors.gray[600] }}>
                              Price per Credit
                            </p>
                            <p style={{ margin: '0.25rem 0 0 0', fontSize: '1.125rem', fontWeight: 600, color: colors.gray[900] }}>
                              ${sale.price.toFixed(2)}
                            </p>
                          </div>
                          
                          <div>
                            <p style={{ margin: 0, fontSize: '0.75rem', color: colors.gray[600] }}>
                              Total Cost
                            </p>
                            <p style={{ margin: '0.25rem 0 0 0', fontSize: '1.125rem', fontWeight: 600, color: colors.gray[900] }}>
                              ${(sale.creditAmount * sale.price).toFixed(2)}
                            </p>
                          </div>
                        </div>
                        
                        <button
                          onClick={() => handleBuyCreditTransaction(sale)}
                          disabled={isProcessingTransaction}
                          style={{
                            width: '100%',
                            background: colors.green[600],
                            color: colors.white,
                            border: 'none',
                            borderRadius: '0.5rem',
                            padding: '0.75rem 1rem',
                            fontSize: '0.875rem',
                            fontWeight: 500,
                            cursor: isProcessingTransaction ? 'not-allowed' : 'pointer',
                            opacity: isProcessingTransaction ? 0.7 : 1,
                            display: 'flex',
                            justifyContent: 'center',
                            alignItems: 'center',
                            gap: '0.5rem'
                          }}
                        >
                          {isProcessingTransaction ? (
                            <>
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ animation: 'spin 1s linear infinite'}}>
                                <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.3)" strokeWidth="4" />
                                <path d="M12 2C6.47715 2 2 6.47715 2 12" stroke="white" strokeWidth="4" />
                              </svg>
                              Processing...
                            </>
                          ) : (
                            <>
                              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="12" cy="12" r="10"></circle>
                                <line x1="8" y1="12" x2="16" y2="12"></line>
                              </svg>
                              Buy Credit
                            </>
                          )}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          
          <div style={styles.modalFooter}>
            <button
              onClick={() => setShowTransactionModal(false)}
              style={styles.secondaryButton}
            >
              Cancel
            </button>
            
            {transactionType === 'sell' && (
              <button
                onClick={handlePostSale}
                disabled={isProcessingTransaction || !creditAmount || !creditPrice}
                style={{
                  ...styles.primaryButton,
                  opacity: (isProcessingTransaction || !creditAmount || !creditPrice) ? 0.7 : 1,
                  cursor: (isProcessingTransaction || !creditAmount || !creditPrice) ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'center',
                  gap: '0.5rem'
                }}
                onMouseEnter={(e) => {
                  if (!isProcessingTransaction && creditAmount && creditPrice) {
                    e.currentTarget.style.backgroundColor = styles.primaryButtonHover.backgroundColor;
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = styles.primaryButton.backgroundColor;
                }}
              >
                {isProcessingTransaction ? (
                  <>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ animation: 'spin 1s linear infinite'}}>
                      <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.3)" strokeWidth="4" />
                      <path d="M12 2C6.47715 2 2 6.47715 2 12" stroke="white" strokeWidth="4" />
                    </svg>
                    Posting...
                  </>
                ) : (
                  <>
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10"></circle>
                      <line x1="8" y1="12" x2="16" y2="12"></line>
                    </svg>
                    Post Sale
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  // Helper function to preserve scroll position
  const preserveScrollPosition = (ref: React.RefObject<HTMLDivElement>) => {
    if (ref.current) {
      const scrollTop = ref.current.scrollTop;
      setTimeout(() => {
        if (ref.current) {
          ref.current.scrollTop = scrollTop;
        }
      }, 0);
    }
  };

  // Update the refreshEmployeeCredits function to reset calculation refs
  const refreshEmployeeCredits = async () => {
    if (!currentOrganization || employees.length === 0) return;
    
    try {
      showToast('Refreshing employee credits...', 'info');
      
      // Reset calculation refs to force a fresh calculation
      creditsCalculatedRef.current = false;
      
      // Get all employee IDs
      const employeeIds = employees.map(emp => emp.id);
      
      // Re-fetch trips to ensure we have the latest data
      await fetchEmployeeTrips(employeeIds);
      
      // Recalculate org totals
      await calculateTotalOrgCredits(currentOrganization.id, employeeIds);
      
      showToast('Employee credits updated successfully', 'success');
    } catch (error) {
      console.error("Error refreshing employee credits:", error);
      showToast('Failed to refresh employee credits', 'error');
    }
  };

  // Update the main return function to use the EmployeeListSection component
  return (
    <>
      <div style={styles.container}>
        <Header userData={userData} showSearch={false} />
        
        <div style={styles.mainContent}>
          <div style={styles.contentArea}>
          
            {loading ? (
              <div style={styles.loadingContainer}>
                <div style={styles.loadingSpinner} />
                <p style={styles.loadingText}>Loading dashboard...</p>
              </div>
            ) : currentOrganization ? (
              <div style={styles.dashboardContainer}>
                <div style={styles.statsRow}>
                  <div style={styles.statsCard}>
                    <h4 style={styles.statsTitle}>Organization Domain</h4>
                    <p style={styles.statsValue}>{currentOrganization.domain}</p>
                  </div>
                  <div style={styles.statsCard}>
                    <h4 style={styles.statsTitle}>Total Employees</h4>
                    <p style={styles.statsValue}>{employees.length}</p>
                  </div>
                  <div style={styles.statsCard} title="Credits earned by employees through sustainable commuting">
                    <h4 style={styles.statsTitle}>Employee Earned Credits</h4>
                    <p style={styles.statsValue}>{employeeEarnedCredits.toFixed(2)}</p>
                    <p style={{ 
                      fontSize: '0.75rem', 
                      color: colors.gray[500], 
                      margin: '0.25rem 0 0 0' 
                    }}>
                      Earned through commuting
                    </p>
                  </div>
                  <div style={styles.statsCard} title="Total credits available = Employee earned + Purchased - Sold">
                    <h4 style={styles.statsTitle}>Available Credits</h4>
                    <p style={styles.statsValue}>{totalOrgCredits.toFixed(2)}</p>
                    <p style={{ 
                      fontSize: '0.75rem', 
                      color: colors.gray[500], 
                      margin: '0.25rem 0 0 0' 
                    }}>
                      Available for trading
                    </p>
                  </div>
                </div>
                
                <div style={styles.dashboardGrid}>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <CreditBreakdownCard />
                  </div>
                </div>
                
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '1.5rem'
                }}>
                  <h2 style={{ margin: 0, fontSize: '1.25rem', color: colors.gray[800] }}>
                    Carbon Credit Management
                  </h2>
                  <div style={{ display: 'flex', gap: '0.75rem' }}>
                    <button
                      onClick={() => {
                        setTransactionType('buy');
                        setShowTransactionModal(true);
                        fetchAvailableSales();
                      }}
                      style={{
                        backgroundColor: transactionType === 'buy' ? colors.green[600] : 'white',
                        color: transactionType === 'buy' ? 'white' : colors.gray[800],
                        border: `1px solid ${colors.green[600]}`,
                        borderRadius: '0.375rem',
                        padding: '0.5rem 1rem',
                        fontSize: '0.875rem',
                        fontWeight: 500,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem'
                      }}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10"></circle>
                        <line x1="12" y1="8" x2="12" y2="16"></line>
                        <line x1="8" y1="12" x2="16" y2="12"></line>
                      </svg>
                      Buy Credits
                    </button>
                    <button
                      onClick={() => {
                        setTransactionType('sell');
                        setShowTransactionModal(true);
                      }}
                      style={{
                        backgroundColor: transactionType === 'sell' ? colors.green[600] : 'white',
                        color: transactionType === 'sell' ? 'white' : colors.gray[800],
                        border: `1px solid ${colors.green[600]}`,
                        borderRadius: '0.375rem',
                        padding: '0.5rem 1rem',
                        fontSize: '0.875rem',
                        fontWeight: 500,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem'
                      }}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10"></circle>
                        <polyline points="8 12 12 16 16 12"></polyline>
                        <line x1="12" y1="8" x2="12" y2="16"></line>
                      </svg>
                      Sell Credits
                    </button>
                  </div>
                </div>
                
                {/* Employee list section */}
                <EmployeeListSection />
                
                {/* Transaction history section */}
                <TransactionHistorySection />
                
                {/* All trips table */}
                <AllEmployeeTripsTable />
                
                {/* Pending employees section */}
                {pendingEmployees.length > 0 && (
                  <>
                    <div style={styles.sectionTitle || { 
                      display: 'flex', 
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: '1rem'
                    }}>
                      <h3 style={{ margin: 0 }}>Pending Employee Approvals</h3>
                    </div>
                    
                    <div style={{
                      ...styles.card,
                      marginBottom: '1.5rem'
                    }}>
                      <div 
                        ref={pendingEmployeesScrollRef}
                        style={{ 
                          overflow: 'auto', 
                          maxHeight: '300px',
                          padding: '0.25rem'
                        }} 
                        className={`${scrollbarStyles.scrollable} ${scrollbarStyles.scrollbarCustom}`}
                      >
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                          <thead>
                            <tr>
                              <th style={{
                                padding: '0.75rem',
                                textAlign: 'left',
                                fontSize: '0.875rem',
                                fontWeight: 600,
                                color: colors.gray[700],
                                borderBottom: `1px solid ${colors.gray[200]}`
                              }}>Name</th>
                              <th style={{
                                padding: '0.75rem',
                                textAlign: 'left',
                                fontSize: '0.875rem',
                                fontWeight: 600,
                                color: colors.gray[700],
                                borderBottom: `1px solid ${colors.gray[200]}`
                              }}>Email</th>
                              <th style={{
                                padding: '0.75rem',
                                textAlign: 'left',
                                fontSize: '0.875rem',
                                fontWeight: 600,
                                color: colors.gray[700],
                                borderBottom: `1px solid ${colors.gray[200]}`
                              }}>Request Date</th>
                              <th style={{
                                padding: '0.75rem',
                                textAlign: 'right',
                                fontSize: '0.875rem',
                                fontWeight: 600,
                                color: colors.gray[700],
                                borderBottom: `1px solid ${colors.gray[200]}`
                              }}>Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {pendingEmployees.map((employee) => (
                              <tr key={employee.id}>
                                <td style={{
                                  padding: '0.75rem',
                                  fontSize: '0.875rem',
                                  color: colors.gray[800],
                                  borderBottom: `1px solid ${colors.gray[200]}`
                                }}>{employee.fullName}</td>
                                <td style={{
                                  padding: '0.75rem',
                                  fontSize: '0.875rem',
                                  color: colors.gray[800],
                                  borderBottom: `1px solid ${colors.gray[200]}`
                                }}>{employee.email}</td>
                                <td style={{
                                  padding: '0.75rem',
                                  fontSize: '0.875rem',
                                  color: colors.gray[800],
                                  borderBottom: `1px solid ${colors.gray[200]}`
                                }}>{new Date(employee.createdAt).toLocaleDateString()}</td>
                                <td style={{
                                  padding: '0.75rem',
                                  fontSize: '0.875rem',
                                  borderBottom: `1px solid ${colors.gray[200]}`,
                                  textAlign: 'right'
                                }}>
                                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                                    <button
                                      onClick={() => handleEmployeeApproval(employee.id, true)}
                                      disabled={isProcessingApproval}
                                      style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '0.25rem',
                                        padding: '0.375rem 0.625rem',
                                        backgroundColor: colors.green[50],
                                        color: colors.green[600],
                                        border: `1px solid ${colors.green[200]}`,
                                        borderRadius: '0.375rem',
                                        fontSize: '0.75rem',
                                        fontWeight: 500,
                                        cursor: isProcessingApproval ? 'not-allowed' : 'pointer',
                                        opacity: isProcessingApproval ? 0.7 : 1,
                                        transition: 'all 0.2s ease'
                                      }}
                                    >
                                      <CheckCircleIcon width={16} height={16} />
                                      Approve
                                    </button>
                                    <button
                                      onClick={() => handleEmployeeApproval(employee.id, false)}
                                      disabled={isProcessingApproval}
                                      style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '0.25rem',
                                        padding: '0.375rem 0.625rem',
                                        backgroundColor: colors.red[50],
                                        color: colors.red[600],
                                        border: `1px solid ${colors.red[200]}`,
                                        borderRadius: '0.375rem',
                                        fontSize: '0.75rem',
                                        fontWeight: 500,
                                        cursor: isProcessingApproval ? 'not-allowed' : 'pointer',
                                        opacity: isProcessingApproval ? 0.7 : 1,
                                        transition: 'all 0.2s ease'
                                      }}
                                    >
                                      <XCircleIcon width={16} height={16} />
                                      Reject
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: '2rem' }}>
                <p>No organization found for your domain. Please contact the administrator.</p>
              </div>
            )}
            
          </div>
        </div>
      </div>
      
      {/* Modals */}
      {showCreditHistoryModal && <EmployeeCreditHistoryModal />}
      {showDeleteModal && <DeleteConfirmationModal />}
      {showTransactionModal && <TransactionModal />}
      {toast && (
        <div style={styles.toast}>
          {toast.message}
        </div>
      )}
    </>
  );
};

export default EmployerDashboard; 